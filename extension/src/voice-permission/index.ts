import type { VoicePermissionToBackgroundMessage } from "../shared/messages";

interface Copy {
  title: string;
  description: string;
  idleStatus: string;
  requestingStatus: string;
  grantedStatus: string;
  dismissedStatus: string;
  deniedStatus: string;
  sendFailedStatus: string;
  unsupportedStatus: string;
  button: string;
  retryButton: string;
}

const COPY: Record<"zh" | "en", Copy> = {
  zh: {
    title: "允许麦克风",
    description: "SyncRoom 需要麦克风权限，才能在当前房间里开麦说话。",
    idleStatus: "点击按钮后，请在浏览器权限提示中选择允许。",
    requestingStatus: "正在请求麦克风权限...",
    grantedStatus: "麦克风权限已允许，正在返回房间语音。",
    dismissedStatus: "这次没有完成授权。请点击按钮，再在浏览器提示中选择允许。",
    deniedStatus:
      "麦克风权限已被浏览器拒绝。请在扩展或浏览器站点设置中允许麦克风后重试。",
    sendFailedStatus: "麦克风权限已允许，但无法通知后台。请关闭窗口后重试。",
    unsupportedStatus: "当前浏览器环境不支持麦克风授权。",
    button: "允许麦克风",
    retryButton: "重试授权",
  },
  en: {
    title: "Allow microphone",
    description:
      "SyncRoom needs microphone access before you can speak in the room.",
    idleStatus: "Click the button, then choose Allow in the browser prompt.",
    requestingStatus: "Requesting microphone permission...",
    grantedStatus: "Microphone permission granted. Returning to room voice.",
    dismissedStatus:
      "Permission was not completed. Click the button and choose Allow in the browser prompt.",
    deniedStatus:
      "Microphone permission was denied by the browser. Allow it in extension or browser settings, then retry.",
    sendFailedStatus:
      "Microphone permission was granted, but the background page could not be notified. Close this window and retry.",
    unsupportedStatus:
      "This browser context does not support microphone access.",
    button: "Allow microphone",
    retryButton: "Retry permission",
  },
};

const params = new URLSearchParams(location.search);
const requestId = params.get("requestId") ?? "";
const copy = resolveCopy();
const title = getRequiredElement<HTMLHeadingElement>("title");
const description = getRequiredElement<HTMLParagraphElement>("description");
const status = getRequiredElement<HTMLParagraphElement>("status");
const requestButton = getRequiredElement<HTMLButtonElement>("requestButton");

document.documentElement.lang = copy === COPY.en ? "en" : "zh-CN";
title.textContent = copy.title;
description.textContent = copy.description;
requestButton.textContent = copy.button;
requestButton.addEventListener("click", () => {
  void requestMicrophonePermission();
});

if (!requestId) {
  setStatus("error", "Missing microphone permission request id.");
  requestButton.disabled = true;
} else {
  setStatus("idle", copy.idleStatus);
  window.setTimeout(() => {
    void requestMicrophonePermission();
  }, 250);
}

async function requestMicrophonePermission(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("error", copy.unsupportedStatus);
    await sendResult({ granted: false, error: "getUserMedia unavailable" });
    return;
  }

  requestButton.disabled = true;
  requestButton.textContent = copy.button;
  setStatus("idle", copy.requestingStatus);

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
  } catch (error) {
    const permissionState = await queryMicrophonePermissionState();
    const message = formatError(error);
    if (permissionState === "denied") {
      setStatus("error", copy.deniedStatus);
      await sendResult({ granted: false, error: message });
      requestButton.disabled = false;
      requestButton.textContent = copy.retryButton;
      return;
    }

    setStatus("error", copy.dismissedStatus);
    requestButton.disabled = false;
    requestButton.textContent = copy.retryButton;
  } finally {
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
  }

  setStatus("success", copy.grantedStatus);
  try {
    await sendResult({ granted: true });
    window.setTimeout(() => {
      window.close();
    }, 600);
  } catch {
    setStatus("error", copy.sendFailedStatus);
    requestButton.disabled = false;
    requestButton.textContent = copy.retryButton;
  }
}

async function sendResult(result: {
  granted: boolean;
  error?: string;
}): Promise<void> {
  if (!requestId) {
    return;
  }
  const message: VoicePermissionToBackgroundMessage = {
    type: "voice-permission:result",
    requestId,
    granted: result.granted,
  };
  if (result.error) {
    message.error = result.error;
  }
  await chrome.runtime.sendMessage(message);
}

async function queryMicrophonePermissionState(): Promise<PermissionState | null> {
  if (!navigator.permissions?.query) {
    return null;
  }
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state;
  } catch {
    return null;
  }
}

function resolveCopy(): Copy {
  const locale =
    chrome.i18n?.getUILanguage?.() ?? globalThis.navigator?.language ?? "zh-CN";
  return /^en\b/i.test(locale) ? COPY.en : COPY.zh;
}

function setStatus(tone: "idle" | "success" | "error", message: string): void {
  status.textContent = message;
  if (tone === "idle") {
    status.removeAttribute("data-tone");
    return;
  }
  status.dataset.tone = tone;
}

function getRequiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name || "Error"}: ${error.message}`;
  }
  return String(error);
}
