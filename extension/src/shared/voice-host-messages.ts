export interface VoiceHostConnectPayload {
  livekitUrl: string;
  token: string;
  roomName: string;
  participantIdentity: string;
}

export type VoiceRuntimeEvent =
  | {
      type: "participant-state";
      participantIdentity: string;
      connected: boolean;
      muted: boolean;
      speaking?: boolean;
    }
  | {
      type: "connection-state";
      connected: boolean;
    }
  | {
      type: "audio-playback-failed";
      message: string;
    }
  | {
      type: "diagnostic-log";
      message: string;
    };

export type VoiceHostCommand =
  | {
      type: "voice-host:connect";
      requestId: string;
      payload: VoiceHostConnectPayload;
    }
  | {
      type: "voice-host:set-microphone-enabled";
      requestId: string;
      enabled: boolean;
    }
  | {
      type: "voice-host:disconnect";
      requestId: string;
    };

export type VoiceHostResponse =
  | {
      type: "voice-host:response";
      requestId: string;
      ok: true;
    }
  | {
      type: "voice-host:response";
      requestId: string;
      ok: false;
      error: string;
      permissionDenied?: boolean;
    };

export interface VoiceHostEventMessage {
  type: "voice-host:event";
  event: VoiceRuntimeEvent;
}
