import type {
  ContentToBackgroundMessage,
  PopupToBackgroundMessage,
} from "../shared/messages";

type RuntimeMessage = PopupToBackgroundMessage | ContentToBackgroundMessage;

export function registerBackgroundListeners(args: {
  // Settles after either restored state or the initialization error is ready.
  bootstrapCompleted: Promise<void>;
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
      const handleMessage = () => {
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
          return;
        }
        void args.messageController.handleRuntimeMessage(
          message,
          sender,
          sendResponse,
        );
      };
      // Never expose provisional defaults as a saved popup state. Other
      // messages keep their existing initialization guard instead of queuing
      // content-script events that may be stale by the time storage loads.
      if (message.type === "popup:get-state") {
        void args.bootstrapCompleted.then(handleMessage);
      } else {
        handleMessage();
      }
      return true;
    },
  );

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup-state") {
      return;
    }
    let disconnected = false;
    const onDisconnect = () => {
      disconnected = true;
    };
    port.onDisconnect.addListener(onDisconnect);
    void args.bootstrapCompleted.then(() => {
      port.onDisconnect.removeListener(onDisconnect);
      if (!disconnected) {
        args.popupStateController.attachPort(port);
      }
    });
  });
}
