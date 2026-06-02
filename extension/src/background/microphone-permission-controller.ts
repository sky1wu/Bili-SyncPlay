import type { VoicePermissionToBackgroundMessage } from "../shared/messages";

export interface MicrophonePermissionResult {
  granted: boolean;
  error?: string;
}

export interface MicrophonePermissionController {
  ensurePermission(): Promise<MicrophonePermissionResult>;
  handlePermissionResult(message: VoicePermissionToBackgroundMessage): boolean;
}

interface PendingPermissionRequest {
  requestId: string;
  windowId: number | null;
  promise: Promise<MicrophonePermissionResult>;
  resolve: (result: MicrophonePermissionResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export function createMicrophonePermissionController(args: {
  log: (message: string) => void;
  timeoutMs?: number;
}): MicrophonePermissionController {
  const timeoutMs = args.timeoutMs ?? 90_000;
  let hasKnownGrant = false;
  let pendingRequest: PendingPermissionRequest | null = null;

  chrome.windows?.onRemoved?.addListener?.((windowId) => {
    const pending = pendingRequest;
    if (!pending || pending.windowId !== windowId) {
      return;
    }
    finishPending(pending.requestId, {
      granted: false,
      error: "Microphone permission window was closed.",
    });
  });

  async function ensurePermission(): Promise<MicrophonePermissionResult> {
    if (hasKnownGrant) {
      return { granted: true };
    }
    if (pendingRequest) {
      return pendingRequest.promise;
    }

    const requestId = createRequestId();
    const promise = new Promise<MicrophonePermissionResult>((resolve) => {
      const timeoutId = setTimeout(() => {
        finishPending(requestId, {
          granted: false,
          error: "Microphone permission request timed out.",
        });
      }, timeoutMs);
      pendingRequest = {
        requestId,
        windowId: null,
        promise: Promise.resolve({ granted: false }),
        resolve,
        timeoutId,
      };
    });
    if (pendingRequest) {
      pendingRequest.promise = promise;
    }

    const url = chrome.runtime.getURL(
      `voice-permission.html?requestId=${encodeURIComponent(requestId)}`,
    );
    args.log("Opening microphone permission window");
    try {
      const createdWindow = await chrome.windows.create({
        url,
        type: "popup",
        width: 420,
        height: 320,
        focused: true,
      });
      if (pendingRequest?.requestId === requestId) {
        pendingRequest.windowId = createdWindow?.id ?? null;
      }
    } catch (error) {
      finishPending(requestId, {
        granted: false,
        error: `Unable to open microphone permission window: ${formatError(
          error,
        )}`,
      });
    }

    return promise;
  }

  function handlePermissionResult(
    message: VoicePermissionToBackgroundMessage,
  ): boolean {
    const handled = finishPending(message.requestId, {
      granted: message.granted,
      error: message.error,
    });
    if (handled && message.granted) {
      hasKnownGrant = true;
    }
    return handled;
  }

  function finishPending(
    requestId: string,
    result: MicrophonePermissionResult,
  ): boolean {
    const pending = pendingRequest;
    if (!pending || pending.requestId !== requestId) {
      return false;
    }

    clearTimeout(pending.timeoutId);
    pendingRequest = null;
    const resolvedResult = normalizeResult(result);
    args.log(
      resolvedResult.granted
        ? "Microphone permission granted"
        : `Microphone permission not granted: ${
            resolvedResult.error ?? "unknown"
          }`,
    );
    pending.resolve(resolvedResult);
    return true;
  }

  return {
    ensurePermission,
    handlePermissionResult,
  };
}

function normalizeResult(
  result: MicrophonePermissionResult,
): MicrophonePermissionResult {
  if (result.error) {
    return result;
  }
  return { granted: result.granted };
}

function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name || "Error"}: ${error.message}`;
  }
  return String(error);
}
