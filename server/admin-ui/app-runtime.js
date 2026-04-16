import { createAdminApi } from "./api.js";
import { createMockApiRequest } from "./demo-data.js";
import { createPageLoaders } from "./page-renderers.js";
import {
  AUTO_REFRESH_MS,
  DEMO_QUERY_KEY,
  clearAuth as clearAuthState,
  clearNotice as clearNoticeState,
  clearRefreshTimer as clearRefreshTimerState,
  normalizePath,
  routeHref,
  routeMeta,
  setToken as setTokenState,
  showNotice as showNoticeState,
  withDemoQuery,
} from "./state.js";
import {
  formatJson,
  resolveConsoleContext,
  serializeQueryParams,
} from "./render-utils.js";
import {
  escapeHtml,
  renderDialog as renderDialogTemplate,
  renderLoginScreen as renderLoginTemplate,
  renderNavLink as renderNavLinkTemplate,
} from "./templates.js";

export function createAdminApp({
  document = globalThis.document,
  location = globalThis.location,
  history = globalThis.history,
  navigator = globalThis.navigator,
  state,
}) {
  let dialogEventsBound = false;
  const appRoot = document.querySelector("#app");

  function clearRefreshTimer() {
    clearRefreshTimerState(state);
  }

  function clearAuth() {
    clearAuthState(state);
  }

  function showNotice(type, message) {
    showNoticeState(state, type, message);
  }

  function clearNotice() {
    clearNoticeState(state);
  }

  function setToken(token) {
    setTokenState(state, token);
  }

  function serializeQuery(query) {
    return serializeQueryParams(query, {
      isDemo: state.demo,
      demoQueryKey: DEMO_QUERY_KEY,
    });
  }

  function rerender() {
    render().catch(handleFatalRenderError);
  }

  function navigate(path, replace = false) {
    state.currentRoute = path;
    const method = replace ? history.replaceState : history.pushState;
    method.call(history, null, "", withDemoQuery(routeHref(path)));
    rerender();
  }

  function navigateToUrl(url, path, replace = false) {
    state.currentRoute = path;
    const method = replace ? history.replaceState : history.pushState;
    method.call(history, null, "", url);
    rerender();
  }

  const api = createAdminApi({
    state,
    serializeQuery,
    clearAuth,
    navigate,
    mockRequest: createMockApiRequest(),
  });

  function canManage() {
    return (
      state.me && (state.me.role === "operator" || state.me.role === "admin")
    );
  }

  function syncDialogDom() {
    const dialogRoot = document.querySelector(".dialog-root");
    if (!dialogRoot) {
      return;
    }

    if (!state.dialog) {
      dialogRoot.hidden = true;
      dialogRoot.replaceChildren();
      return;
    }

    dialogRoot.outerHTML = renderDialog();
  }

  function closeDialog(result = null) {
    const resolver = state.dialog?.resolve;
    state.dialog = null;
    syncDialogDom();
    if (resolver) {
      resolver(result);
    }
    rerender();
  }

  function bindDialogEvents() {
    if (dialogEventsBound) {
      return;
    }

    dialogEventsBound = true;

    document.addEventListener("click", (event) => {
      const closeButton = event.target.closest("[data-dialog-close]");
      if (!closeButton) {
        return;
      }

      event.preventDefault();
      closeDialog(null);
    });

    document.addEventListener("submit", (event) => {
      const form = event.target.closest("#confirm-dialog");
      if (!form) {
        return;
      }

      event.preventDefault();
      const reason = new FormData(form).get("reason")?.toString().trim() || "";
      closeDialog({ reason });
    });
  }

  async function withAction(action, successMessage, onSuccess) {
    try {
      const result = await action();
      if (successMessage) {
        showNotice("success", successMessage);
      }
      if (typeof onSuccess === "function") {
        await onSuccess(result);
      } else {
        await render();
      }
      return result;
    } catch (error) {
      showNotice("error", error.message || "操作失败。");
      rerender();
      return null;
    }
  }

  async function openReasonDialog(config) {
    return new Promise((resolve) => {
      state.dialog = {
        ...config,
        resolve,
      };
      rerender();
    });
  }

  async function confirmAction(config) {
    const result = await openReasonDialog(config);
    if (!result) {
      return;
    }
    await withAction(
      () => config.onConfirm(result.reason),
      config.successMessage,
      config.onSuccess,
    );
  }

  function renderDialog() {
    return renderDialogTemplate(state.dialog, formatJson);
  }

  function renderNavLink(path, label) {
    return renderNavLinkTemplate({
      active: state.currentRoute === path,
      href: withDemoQuery(routeHref(path)),
      label,
      path,
    });
  }

  async function ensureInstanceId() {
    try {
      const config = await api.getConfig();
      state.instanceId = config.instanceId || "";
    } catch {
      // ignore; the current page can still render without instance metadata
    }
  }

  function bindCommonEvents(page) {
    document.querySelectorAll("[data-nav]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        navigate(element.getAttribute("data-nav"));
      });
    });

    document
      .querySelector("[data-action='logout']")
      ?.addEventListener("click", async () => {
        try {
          await api.logout();
        } catch {
          // ignore
        }
        clearAuth();
        navigate("/login", true);
      });

    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.getAttribute("data-copy"));
          showNotice("success", "已复制到剪贴板。");
        } catch {
          showNotice("error", "复制失败。");
        }
        rerender();
      });
    });

    if (page.autoRefresh) {
      state.refreshHandle = setInterval(() => {
        rerender();
      }, AUTO_REFRESH_MS);
    }

    if (state.notice?.type === "success") {
      setTimeout(() => {
        if (state.notice?.type === "success") {
          clearNotice();
          rerender();
        }
      }, 2400);
    }
  }

  function renderLogin() {
    appRoot.innerHTML = renderLoginTemplate(state.notice);
  }

  function bindLoginEvents() {
    document
      .querySelector("#login-form")
      ?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const username = formData.get("username")?.toString().trim() || "";
        const password = formData.get("password")?.toString() || "";

        try {
          clearNotice();
          const result = await api.login({ username, password });
          setToken(result.token);
          state.me = await api.getMe();
          navigate("/overview", true);
        } catch (error) {
          showNotice("error", error.message || "登录失败。");
          renderLogin();
          bindLoginEvents();
        }
      });
  }

  const pageLoaders = createPageLoaders({
    document,
    location,
    history,
    state,
    api,
    routeHref,
    withDemoQuery,
    serializeQuery,
    navigate,
    navigateToUrl,
    rerender,
    handleFatalRenderError,
    canManage,
    confirmAction,
    openReasonDialog,
  });

  async function loadPage() {
    switch (state.currentRoute) {
      case "/overview":
        return pageLoaders.renderOverviewPage();
      case "/rooms":
        return pageLoaders.renderRoomsPage();
      case "/events":
        return pageLoaders.renderEventsPage();
      case "/audit-logs":
        return pageLoaders.renderAuditLogsPage();
      case "/config":
        return pageLoaders.renderConfigPage();
      default:
        if (state.currentRoute.startsWith("/rooms/")) {
          return pageLoaders.renderRoomDetailPage(
            state.currentRoute.slice("/rooms/".length),
          );
        }
        navigate("/overview", true);
        return pageLoaders.renderOverviewPage();
    }
  }

  function handleFatalRenderError(error) {
    console.error(error);
    showNotice("error", "页面渲染失败。");
    appRoot.innerHTML = `<div class="login-shell"><div class="login-card"><h1>渲染失败</h1><p>${escapeHtml(error.message || "未知错误")}</p></div></div>`;
  }

  async function render() {
    clearRefreshTimer();

    if (!state.token || state.currentRoute === "/login") {
      renderLogin();
      bindLoginEvents();
      return;
    }

    const page = await loadPage();
    if (page.instanceId) {
      state.instanceId = page.instanceId;
    }
    if (!page.instanceId && !state.instanceId) {
      await ensureInstanceId();
    }
    const meta =
      page.meta || routeMeta[state.currentRoute] || routeMeta["/overview"];
    const instanceId =
      page.instanceId ||
      state.instanceId ||
      state.lastOverviewData?.instanceId ||
      "—";
    const consoleContext = resolveConsoleContext(
      instanceId,
      page.serviceName || state.lastOverviewData?.name,
    );
    document.title = `${meta.title} | Bili-SyncPlay Admin`;

    appRoot.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="brand">
            <span class="brand-eyebrow">Admin</span>
            <h1>Bili-SyncPlay</h1>
          </div>
          <nav class="nav">
            ${renderNavLink("/overview", "概览")}
            ${renderNavLink("/rooms", "房间管理")}
            ${renderNavLink("/events", "运行事件")}
            ${renderNavLink("/audit-logs", "审计日志")}
            ${renderNavLink("/config", "配置")}
          </nav>
          <div class="sidebar-meta-card">
            <div class="sidebar-meta-kicker">${escapeHtml(consoleContext.label)}</div>
            <strong>${escapeHtml(instanceId)}</strong>
          </div>
        </aside>
        <main class="main">
          <div class="main-inner">
          <section class="topbar-card">
            <div class="topbar">
              <div class="page-title">
                <h2>${escapeHtml(meta.title)}</h2>
                <p>${escapeHtml(meta.description)}</p>
              </div>
              <div class="userbar-card">
                <div class="userbar-meta">
                  <div class="userbar-name">${escapeHtml(state.me.username)}</div>
                  <span class="pill">${escapeHtml(state.me.role)}</span>
                </div>
                <button class="button ghost" data-action="logout">退出</button>
              </div>
            </div>
          </section>
          ${state.notice ? `<div class="notice ${escapeHtml(state.notice.type)}">${escapeHtml(state.notice.message)}</div>` : ""}
          ${page.html}
          </div>
        </main>
      </div>
      ${renderDialog()}
    `;

    bindCommonEvents(page);
    if (typeof page.bind === "function") {
      page.bind();
    }
  }

  async function bootstrap() {
    bindDialogEvents();
    state.currentRoute = normalizePath(location.pathname);

    if (state.demo) {
      state.token = "demo-token";
      state.me = { id: "admin-demo", username: "demo-admin", role: "admin" };
      await render();
      return;
    }

    if (state.token) {
      try {
        state.me = await api.getMe();
      } catch (error) {
        if (error.code !== "unauthorized") {
          showNotice("error", error.message || "管理员身份校验失败。");
        }
        clearAuth();
      }
    }

    if (!state.token && state.currentRoute !== "/login") {
      navigate("/login", true);
      return;
    }

    if (state.token && state.currentRoute === "/login") {
      navigate("/overview", true);
      return;
    }

    await render();
  }

  function installPopStateHandler() {
    window.addEventListener("popstate", () => {
      state.currentRoute = normalizePath(location.pathname);
      rerender();
    });
  }

  return {
    api,
    bootstrap,
    render,
    navigate,
    navigateToUrl,
    confirmAction,
    openReasonDialog,
    handleFatalRenderError,
    installPopStateHandler,
  };
}
