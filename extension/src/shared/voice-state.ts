export type VoiceConnectionStatus =
  | "idle"
  | "requesting"
  | "connecting"
  | "connected"
  | "unavailable"
  | "failed";

export interface VoiceParticipantState {
  memberId: string;
  connected: boolean;
  muted: boolean;
  speaking: boolean;
}

export interface VoiceRuntimeState {
  status: VoiceConnectionStatus;
  muted: boolean;
  speaking: boolean;
  error: string | null;
  roomCode: string | null;
  roomName: string | null;
  participantIdentity: string | null;
  expiresAt: number | null;
  accessRequestedFor: string | null;
  participants: Record<string, VoiceParticipantState>;
}

export function createInitialVoiceRuntimeState(): VoiceRuntimeState {
  return {
    status: "idle",
    muted: true,
    speaking: false,
    error: null,
    roomCode: null,
    roomName: null,
    participantIdentity: null,
    expiresAt: null,
    accessRequestedFor: null,
    participants: {},
  };
}
