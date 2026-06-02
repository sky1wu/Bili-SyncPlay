import type {
  VoiceHostCommand,
  VoiceHostConnectPayload,
  VoiceHostResponse,
} from "../shared/voice-host-messages";
import {
  VoiceRuntimeAdapterError,
  type VoiceRuntimeAdapter,
  type VoiceRuntimeAdapterFactoryArgs,
} from "./voice-runtime-adapter";

const OFFSCREEN_DOCUMENT_URL = "offscreen.html";

export function createExtensionVoiceRuntimeAdapter(
  args: VoiceRuntimeAdapterFactoryArgs,
): VoiceRuntimeAdapter {
  if (supportsChromeOffscreen()) {
    return createOffscreenVoiceRuntimeAdapter(args);
  }
  if (typeof document !== "undefined") {
    return createInlineVoiceRuntimeAdapter(args);
  }
  return createUnavailableVoiceRuntimeAdapter(
    "No browser media host is available for LiveKit voice.",
  );
}

function createOffscreenVoiceRuntimeAdapter(
  _args: VoiceRuntimeAdapterFactoryArgs,
): VoiceRuntimeAdapter {
  let createDocumentPromise: Promise<void> | null = null;

  async function ensureOffscreenDocument(): Promise<void> {
    const offscreen = chrome.offscreen;
    if (await offscreen.hasDocument()) {
      return;
    }
    if (!createDocumentPromise) {
      createDocumentPromise = offscreen
        .createDocument({
          url: OFFSCREEN_DOCUMENT_URL,
          reasons: ["AUDIO_PLAYBACK", "USER_MEDIA", "WEB_RTC"],
          justification:
            "SyncRoom uses LiveKit voice chat for room audio playback and microphone capture.",
        })
        .finally(() => {
          createDocumentPromise = null;
        });
    }
    await createDocumentPromise;
  }

  async function sendCommand(command: VoiceHostCommand): Promise<void> {
    await ensureOffscreenDocument();
    const response = (await chrome.runtime.sendMessage(
      command,
    )) as VoiceHostResponse;
    validateHostResponse(response, command.requestId);
  }

  return {
    async connect(payload) {
      await sendCommand({
        type: "voice-host:connect",
        requestId: createRequestId(),
        payload,
      });
    },
    async setMicrophoneEnabled(enabled) {
      await sendCommand({
        type: "voice-host:set-microphone-enabled",
        requestId: createRequestId(),
        enabled,
      });
    },
    async disconnect() {
      await sendCommand({
        type: "voice-host:disconnect",
        requestId: createRequestId(),
      });
    },
  };
}

function createInlineVoiceRuntimeAdapter(
  args: VoiceRuntimeAdapterFactoryArgs,
): VoiceRuntimeAdapter {
  let runtimePromise: Promise<VoiceRuntimeAdapter> | null = null;

  async function getRuntime(): Promise<VoiceRuntimeAdapter> {
    if (!runtimePromise) {
      runtimePromise = import("../voice/livekit-voice-runtime").then(
        ({ createLiveKitVoiceRuntime }) =>
          createLiveKitVoiceRuntime({
            onEvent: args.onEvent,
            log: args.log,
          }),
      );
    }
    return runtimePromise;
  }

  return {
    async connect(payload: VoiceHostConnectPayload) {
      const runtime = await getRuntime();
      await runtime.connect(payload);
    },
    async setMicrophoneEnabled(enabled: boolean) {
      const runtime = await getRuntime();
      await runtime.setMicrophoneEnabled(enabled);
    },
    async disconnect() {
      const runtime = await getRuntime();
      await runtime.disconnect();
    },
  };
}

function createUnavailableVoiceRuntimeAdapter(
  message: string,
): VoiceRuntimeAdapter {
  async function fail(): Promise<void> {
    throw new VoiceRuntimeAdapterError(message);
  }

  return {
    connect: fail,
    setMicrophoneEnabled: fail,
    disconnect: async () => undefined,
  };
}

function validateHostResponse(
  response: VoiceHostResponse | undefined,
  requestId: string,
): void {
  if (!response || response.type !== "voice-host:response") {
    throw new VoiceRuntimeAdapterError("Voice host did not respond.");
  }
  if (response.requestId !== requestId) {
    throw new VoiceRuntimeAdapterError("Voice host response mismatched.");
  }
  if (response.ok === false) {
    throw new VoiceRuntimeAdapterError(response.error, {
      permissionDenied: response.permissionDenied,
    });
  }
}

function supportsChromeOffscreen(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.offscreen?.createDocument === "function" &&
    typeof chrome.offscreen?.hasDocument === "function"
  );
}

function createRequestId(): string {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
