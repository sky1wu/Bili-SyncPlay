import {
  formatAnnouncementSchedule,
  type AnnouncementView,
} from "../shared/announcement";
import { t } from "../shared/i18n";
import { isAnnouncementResponse } from "../shared/messages";

export interface AnnouncementBannerController {
  /** Ask the background for the current announcement once. */
  start(): void;
  /** The background's push (`background:announcement`). */
  apply(announcement: AnnouncementView | null): void;
  destroy(): void;
}

export interface AnnouncementBarPresenter {
  show(announcement: AnnouncementView, onDismiss: () => void): void;
  hide(): void;
}

/**
 * The bar itself, pinned at the head of the toast stack (`pin`) so toasts flow
 * below it instead of over it, and it follows the page into fullscreen with
 * them. Styled by the toast stack's `.announcement` rules.
 */
export function createAnnouncementBarPresenter(
  pin: (node: HTMLElement | null) => void,
  getNow: () => number = Date.now,
): AnnouncementBarPresenter {
  return {
    show(announcement, onDismiss) {
      const bar = document.createElement("div");
      bar.className = "announcement";
      bar.setAttribute("role", "alert");
      const icon = document.createElement("span");
      icon.className = "announcement-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "⚠";
      const body = document.createElement("div");
      body.className = "announcement-body";
      // Server-provided text goes in as text only.
      const message = document.createElement("div");
      message.className = "announcement-message";
      message.textContent = announcement.message;
      body.append(message);
      if (announcement.scheduledAt !== null) {
        const meta = document.createElement("div");
        meta.className = "announcement-meta";
        meta.textContent = formatAnnouncementSchedule(
          announcement.scheduledAt,
          getNow(),
        );
        body.append(meta);
      }
      const dismiss = document.createElement("button");
      dismiss.className = "announcement-dismiss";
      dismiss.type = "button";
      dismiss.textContent = "×";
      dismiss.setAttribute("aria-label", t("announcementDismiss"));
      dismiss.title = t("announcementDismiss");
      dismiss.addEventListener("click", onDismiss);
      bar.append(icon, body, dismiss);
      pin(bar);
    },
    hide() {
      pin(null);
    },
  };
}

/**
 * The warning-level announcement as a bar at the top of the page (#325).
 *
 * Unlike a toast it stays until dismissed, and it is the background that
 * decides whether there is one to show — in a room, not expired, not dismissed
 * — so this only renders what it is handed. Info-level announcements live in
 * the popup only.
 */
export function createAnnouncementBanner(args: {
  requestCurrent: () => Promise<unknown>;
  dismiss: (id: string) => void;
  presenter: AnnouncementBarPresenter;
}): AnnouncementBannerController {
  const { presenter } = args;
  let current: AnnouncementView | null = null;
  let pushed = false;
  let destroyed = false;

  function show(announcement: AnnouncementView): void {
    presenter.show(announcement, () => {
      current = null;
      presenter.hide();
      args.dismiss(announcement.id);
    });
  }

  function render(announcement: AnnouncementView | null): void {
    const next = announcement?.level === "warning" ? announcement : null;
    // The same announcement again (it is resent on every rejoin) leaves the
    // bar as it is rather than popping it anew.
    if (next?.id === current?.id) {
      return;
    }
    current = next;
    if (next === null) {
      presenter.hide();
    } else {
      show(next);
    }
  }

  return {
    start() {
      void args
        .requestCurrent()
        .then((response) => {
          // A push that already arrived is newer than this answer.
          if (!destroyed && !pushed && isAnnouncementResponse(response)) {
            render(response.announcement);
          }
        })
        .catch(() => undefined);
    },
    apply(announcement) {
      if (destroyed) {
        return;
      }
      pushed = true;
      render(announcement);
    },
    destroy() {
      destroyed = true;
      current = null;
      presenter.hide();
    },
  };
}
