import type { ClientMessage, ServerMessage } from "@bili-syncplay/protocol";
import { localizeServerError, t } from "../shared/i18n";
import type { VoiceRuntimeEvent } from "../shared/voice-host-messages";
import type { VoiceRuntimeState } from "../shared/voice-state";
import type { ConnectionState, RoomSessionState } from "./runtime-state";
import {
  VoiceRuntimeAdapterError,
  type VoiceRuntimeAdapter,
} from "./voice-runtime-adapter";

export interface VoiceController {
  syncRoomLifecycle(options?: { forceRefresh?: boolean }): Promise<void>;
  handleServerMessage(message: ServerMessage): Promise<boolean>;
  handleRuntimeEvent(event: VoiceRuntimeEvent): void;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  reportMicrophonePermissionDenied(reason?: string): void;
  disconnect(reason: string): Promise<void>;
}

export function createVoiceController(args: {
  connectionState: Pick<ConnectionState, "connected">;
  roomSessionState: Pick<
    RoomSessionState,
    "roomCode" | "memberToken" | "memberId"
  >;
  voiceState: VoiceRuntimeState;
  runtime: VoiceRuntimeAdapter;
  sendToServer: (message: ClientMessage) => void;
  notifyAll: () => void;
  log: (message: string) => void;
}): VoiceController {
  async function syncRoomLifecycle(
    options: { forceRefresh?: boolean } = {},
  ): Promise<void> {
    const roomCode = args.roomSessionState.roomCode;
    const memberToken = args.roomSessionState.memberToken;
    const memberId = args.roomSessionState.memberId;

    if (!roomCode || !memberToken || !memberId) {
      await disconnect("room membership unavailable");
      resetVoiceState();
      args.notifyAll();
      return;
    }

    args.voiceState.roomCode = roomCode;
    ensureSelfParticipant(memberId);

    if (!args.connectionState.connected) {
      return;
    }

    const requestKey = `${roomCode}:${memberToken}`;
    if (
      !options.forceRefresh &&
      args.voiceState.accessRequestedFor === requestKey &&
      args.voiceState.status !== "failed"
    ) {
      return;
    }

    args.voiceState.status = "requesting";
    args.voiceState.error = null;
    args.voiceState.muted = true;
    args.voiceState.accessRequestedFor = requestKey;
    args.log(`Requesting voice access for ${roomCode}`);
    args.sendToServer({
      type: "voice:access",
      payload: { memberToken },
    });
    args.notifyAll();
  }

  async function handleServerMessage(message: ServerMessage): Promise<boolean> {
    if (message.type === "voice:access-granted") {
      await connectWithAccess(message.payload);
      return true;
    }
    if (message.type === "voice:state") {
      updateParticipantState({
        memberId: message.payload.memberId,
        connected: message.payload.connected,
        muted: message.payload.muted,
        speaking: message.payload.speaking ?? false,
      });
      args.notifyAll();
      return true;
    }
    if (message.type === "error" && isVoiceErrorCode(message.payload.code)) {
      await handleVoiceError(message.payload.code, message.payload.message);
      return true;
    }
    return false;
  }

  function handleRuntimeEvent(event: VoiceRuntimeEvent): void {
    switch (event.type) {
      case "participant-state":
        updateParticipantState({
          memberId: event.participantIdentity,
          connected: event.connected,
          muted: event.muted,
          speaking: event.speaking ?? false,
        });
        args.notifyAll();
        return;
      case "connection-state":
        args.voiceState.status = event.connected ? "connected" : "failed";
        args.voiceState.error = event.connected
          ? null
          : t("voiceErrorConnectionFailed");
        args.notifyAll();
        return;
      case "audio-playback-failed":
        args.voiceState.error = event.message || t("voiceErrorAudioPlayback");
        args.notifyAll();
        return;
      case "diagnostic-log":
        args.log(event.message);
        return;
    }
  }

  async function connectWithAccess(
    payload: Extract<
      ServerMessage,
      { type: "voice:access-granted" }
    >["payload"],
  ): Promise<void> {
    args.voiceState.status = "connecting";
    args.voiceState.error = null;
    args.voiceState.roomName = payload.roomName;
    args.voiceState.participantIdentity = payload.participantIdentity;
    args.voiceState.expiresAt = payload.expiresAt;
    args.voiceState.muted = true;
    args.notifyAll();

    try {
      await args.runtime.connect({
        livekitUrl: payload.livekitUrl,
        token: payload.token,
        roomName: payload.roomName,
        participantIdentity: payload.participantIdentity,
      });
      args.voiceState.status = "connected";
      updateParticipantState({
        memberId: payload.participantIdentity,
        connected: true,
        muted: true,
        speaking: false,
      });
      sendVoiceState({ connected: true, muted: true });
      args.log(`Voice connected as ${payload.participantIdentity}`);
    } catch (error) {
      args.voiceState.status = "failed";
      args.voiceState.error = formatRuntimeError(
        error,
        t("voiceErrorConnectionFailed"),
      );
      args.log(`Voice connection failed: ${formatError(error)}`);
    }
    args.notifyAll();
  }

  async function setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (args.voiceState.status !== "connected") {
      args.voiceState.error = t("voiceErrorNotConnected");
      args.notifyAll();
      return;
    }

    try {
      await args.runtime.setMicrophoneEnabled(enabled);
      args.voiceState.muted = !enabled;
      args.voiceState.error = null;
      updateSelfParticipant({ muted: !enabled, connected: true });
      sendVoiceState({ connected: true, muted: !enabled });
      args.log(enabled ? "Voice microphone enabled" : "Voice microphone muted");
    } catch (error) {
      args.voiceState.muted = true;
      updateSelfParticipant({ muted: true, connected: true });
      args.voiceState.error =
        error instanceof VoiceRuntimeAdapterError && error.permissionDenied
          ? t("voiceErrorPermissionDenied")
          : formatRuntimeError(error, t("voiceErrorMicrophoneFailed"));
      args.log(`Voice microphone toggle failed: ${formatError(error)}`);
    }
    args.notifyAll();
  }

  function reportMicrophonePermissionDenied(reason?: string): void {
    args.voiceState.muted = true;
    args.voiceState.error = t("voiceErrorPermissionDenied");
    if (args.voiceState.status === "connected") {
      updateSelfParticipant({ muted: true, connected: true });
      sendVoiceState({ connected: true, muted: true });
    }
    args.log(
      `Voice microphone permission denied before toggle${
        reason ? `: ${reason}` : ""
      }`,
    );
    args.notifyAll();
  }

  async function disconnect(reason: string): Promise<void> {
    const wasConnected =
      args.voiceState.status === "connected" ||
      args.voiceState.status === "connecting" ||
      args.voiceState.status === "requesting";
    try {
      await args.runtime.disconnect();
    } catch (error) {
      args.log(
        `Voice disconnect ignored after ${reason}: ${formatError(error)}`,
      );
    }
    if (wasConnected) {
      sendVoiceState({ connected: false, muted: true });
    }
    resetVoiceState();
    args.log(`Voice state cleared (${reason})`);
    args.notifyAll();
  }

  async function handleVoiceError(
    code: Extract<ServerMessage, { type: "error" }>["payload"]["code"],
    message: string,
  ): Promise<void> {
    await args.runtime.disconnect();
    args.voiceState.status =
      code === "voice_unavailable" || code === "voice_capacity_reached"
        ? "unavailable"
        : "failed";
    args.voiceState.error = localizeServerError(code, message);
    args.voiceState.roomName = null;
    args.voiceState.participantIdentity = null;
    args.voiceState.expiresAt = null;
    args.voiceState.muted = true;
    args.voiceState.participants = {};
    args.log(`Voice access rejected: ${code}`);
    args.notifyAll();
  }

  function sendVoiceState(payload: {
    connected: boolean;
    muted: boolean;
  }): void {
    const memberToken = args.roomSessionState.memberToken;
    if (!memberToken || !args.connectionState.connected) {
      return;
    }
    args.sendToServer({
      type: "voice:state",
      payload: {
        memberToken,
        connected: payload.connected,
        muted: payload.muted,
        speaking: args.voiceState.speaking,
      },
    });
  }

  function ensureSelfParticipant(memberId: string): void {
    if (!args.voiceState.participants[memberId]) {
      args.voiceState.participants[memberId] = {
        memberId,
        connected: false,
        muted: true,
        speaking: false,
      };
    }
  }

  function updateSelfParticipant(
    patch: Partial<Pick<VoiceRuntimeState, "muted">> & {
      connected: boolean;
    },
  ): void {
    const memberId = args.roomSessionState.memberId;
    if (!memberId) {
      return;
    }
    updateParticipantState({
      memberId,
      connected: patch.connected,
      muted: patch.muted ?? args.voiceState.muted,
      speaking: args.voiceState.speaking,
    });
  }

  function updateParticipantState(state: {
    memberId: string;
    connected: boolean;
    muted: boolean;
    speaking: boolean;
  }): void {
    args.voiceState.participants[state.memberId] = {
      memberId: state.memberId,
      connected: state.connected,
      muted: state.muted,
      speaking: state.speaking,
    };
    if (state.memberId === args.roomSessionState.memberId) {
      args.voiceState.muted = state.muted;
      args.voiceState.speaking = state.speaking;
    }
  }

  function resetVoiceState(): void {
    args.voiceState.status = "idle";
    args.voiceState.muted = true;
    args.voiceState.speaking = false;
    args.voiceState.error = null;
    args.voiceState.roomCode = null;
    args.voiceState.roomName = null;
    args.voiceState.participantIdentity = null;
    args.voiceState.expiresAt = null;
    args.voiceState.accessRequestedFor = null;
    args.voiceState.participants = {};
  }

  return {
    syncRoomLifecycle,
    handleServerMessage,
    handleRuntimeEvent,
    setMicrophoneEnabled,
    reportMicrophonePermissionDenied,
    disconnect,
  };
}

function isVoiceErrorCode(code: string): boolean {
  return (
    code === "voice_unavailable" ||
    code === "voice_capacity_reached" ||
    code === "voice_token_failed"
  );
}

function formatRuntimeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
