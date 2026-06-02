import type {
  VoiceHostConnectPayload,
  VoiceRuntimeEvent,
} from "../shared/voice-host-messages";

export class VoiceRuntimeAdapterError extends Error {
  readonly permissionDenied: boolean;

  constructor(message: string, options: { permissionDenied?: boolean } = {}) {
    super(message);
    this.name = "VoiceRuntimeAdapterError";
    this.permissionDenied = options.permissionDenied ?? false;
  }
}

export interface VoiceRuntimeAdapter {
  connect(payload: VoiceHostConnectPayload): Promise<void>;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  disconnect(): Promise<void>;
}

export interface VoiceRuntimeAdapterFactoryArgs {
  onEvent: (event: VoiceRuntimeEvent) => void;
  log: (message: string) => void;
}
