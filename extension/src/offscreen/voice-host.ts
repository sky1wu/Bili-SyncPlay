import type {
  VoiceHostCommand,
  VoiceHostResponse,
  VoiceRuntimeEvent,
} from "../shared/voice-host-messages";
import { createLiveKitVoiceRuntime } from "../voice/livekit-voice-runtime";
import { VoiceRuntimeAdapterError } from "../background/voice-runtime-adapter";

const runtime = createLiveKitVoiceRuntime({
  onEvent: sendRuntimeEvent,
  log: sendRuntimeLog,
});

chrome.runtime.onMessage.addListener(
  (
    message: VoiceHostCommand,
    _sender,
    sendResponse: (response: VoiceHostResponse) => void,
  ) => {
    if (!isVoiceHostCommand(message)) {
      return false;
    }
    void handleCommand(message).then(sendResponse);
    return true;
  },
);

async function handleCommand(
  command: VoiceHostCommand,
): Promise<VoiceHostResponse> {
  try {
    switch (command.type) {
      case "voice-host:connect":
        await runtime.connect(command.payload);
        break;
      case "voice-host:set-microphone-enabled":
        await runtime.setMicrophoneEnabled(command.enabled);
        break;
      case "voice-host:disconnect":
        await runtime.disconnect();
        break;
    }
    return {
      type: "voice-host:response",
      requestId: command.requestId,
      ok: true,
    };
  } catch (error) {
    return {
      type: "voice-host:response",
      requestId: command.requestId,
      ok: false,
      error: formatError(error),
      permissionDenied:
        error instanceof VoiceRuntimeAdapterError && error.permissionDenied,
    };
  }
}

function sendRuntimeEvent(event: VoiceRuntimeEvent): void {
  void chrome.runtime.sendMessage({
    type: "voice-host:event",
    event,
  });
}

function sendRuntimeLog(message: string): void {
  void chrome.runtime.sendMessage({
    type: "voice-host:event",
    event: {
      type: "diagnostic-log",
      message,
    },
  });
}

function isVoiceHostCommand(value: unknown): value is VoiceHostCommand {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === "voice-host:connect" ||
    type === "voice-host:set-microphone-enabled" ||
    type === "voice-host:disconnect"
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
