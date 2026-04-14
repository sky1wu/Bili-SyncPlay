import type {
  BackgroundPopupState,
  BackgroundToPopupMessage,
  PopupToBackgroundMessage,
} from "../shared/messages";
import { isBackgroundPopupStateMessage } from "../shared/messages";

export async function queryPopupState(): Promise<BackgroundPopupState> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: "popup:get-state",
  });
  if (!isBackgroundPopupStateMessage(response)) {
    throw new Error(
      `Unexpected popup state response: ${JSON.stringify(response)}`,
    );
  }
  return response.payload;
}

export async function sendPopupAction(
  message: PopupToBackgroundMessage,
): Promise<BackgroundPopupState> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (!isBackgroundPopupStateMessage(response)) {
    throw new Error(
      `Unexpected response to ${message.type}: ${JSON.stringify(response)}`,
    );
  }
  return response.payload;
}

export function connectPopupStatePort(args: {
  onState: (state: BackgroundPopupState) => void;
  onDisconnect?: () => void;
}): chrome.runtime.Port {
  const port = chrome.runtime.connect({ name: "popup-state" });
  port.onMessage.addListener((message: BackgroundToPopupMessage) => {
    if (message.type !== "background:state") {
      return;
    }
    args.onState(message.payload);
  });
  port.onDisconnect.addListener(() => {
    args.onDisconnect?.();
  });
  return port;
}
