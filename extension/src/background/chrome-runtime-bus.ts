import type {
  ContentToBackgroundMessage,
  PopupToBackgroundMessage,
} from "../shared/messages";

type RuntimeMessage = PopupToBackgroundMessage | ContentToBackgroundMessage;

export function registerBackgroundListeners(args: {
  getBootstrapStatus: () => "pending" | "ready" | "failed";
  bootstrapPendingMessage: string;
  bootstrapFailedMessage: string;
  popupStateController: {
    popupState: () => unknown;
    attachPort: (port: chrome.runtime.Port) => void;
  };
  messageController: {
    handleRuntimeMessage: (
      message: RuntimeMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => Promise<void>;
  };
}): void {
  chrome.runtime.onMessage.addListener(
    (message: RuntimeMessage, sender, sendResponse) => {
      const bootstrapStatus = args.getBootstrapStatus();
      if (bootstrapStatus !== "ready") {
        const error =
          bootstrapStatus === "failed"
            ? args.bootstrapFailedMessage
            : args.bootstrapPendingMessage;
        if (message.type === "popup:get-state") {
          sendResponse(args.popupStateController.popupState());
        } else {
          sendResponse({ ok: false, error });
        }
        return true;
      }
      void args.messageController.handleRuntimeMessage(
        message,
        sender,
        sendResponse,
      );
      return true;
    },
  );

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup-state") {
      return;
    }
    args.popupStateController.attachPort(port);
  });
}
