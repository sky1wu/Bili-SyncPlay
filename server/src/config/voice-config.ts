import type { VoiceConfig } from "../types.js";
import type { EnvSource } from "./env.js";
import { readTrimmedEnv } from "./env.js";
import {
  loadSectionConfigFromEnv,
  VOICE_CONFIG_FIELDS,
} from "./runtime-config-schema.js";

const VOICE_MAX_MEMBERS_LIMIT = 4;

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  livekitUrl: undefined,
  apiKey: undefined,
  apiSecret: undefined,
  tokenTtlSeconds: 900,
  maxMembers: VOICE_MAX_MEMBERS_LIMIT,
};

function assertLiveKitUrl(value: string | undefined): void {
  if (value === undefined) {
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(
      "LIVEKIT_URL must be a valid absolute WebSocket URL using ws:// or wss://.",
    );
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error("LIVEKIT_URL must use ws:// or wss://.");
  }
}

export function getDefaultVoiceConfig(): VoiceConfig {
  return { ...DEFAULT_VOICE_CONFIG };
}

type ReadyVoiceConfig = VoiceConfig & {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
};

export function isVoiceConfigReady(
  config: VoiceConfig,
): config is ReadyVoiceConfig {
  return (
    config.enabled &&
    config.livekitUrl !== undefined &&
    config.apiKey !== undefined &&
    config.apiSecret !== undefined
  );
}

export function loadVoiceConfig(env: EnvSource = process.env): VoiceConfig {
  const config = loadSectionConfigFromEnv(
    env,
    DEFAULT_VOICE_CONFIG,
    VOICE_CONFIG_FIELDS,
  );
  assertLiveKitUrl(config.livekitUrl);

  return {
    ...config,
    apiKey: readTrimmedEnv(env, "LIVEKIT_API_KEY"),
    apiSecret: readTrimmedEnv(env, "LIVEKIT_API_SECRET"),
    maxMembers: Math.min(config.maxMembers, VOICE_MAX_MEMBERS_LIMIT),
  };
}
