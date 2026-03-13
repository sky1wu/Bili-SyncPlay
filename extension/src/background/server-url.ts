import { DEFAULT_SERVER_URL } from "./runtime-state";

export const INVALID_SERVER_URL_MESSAGE = "Server URL must start with ws:// or wss://.";

type ServerUrlValidationResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; message: string };

export interface PersistedServerUrlResolution {
  serverUrl: string;
  lastError: string | null;
  shouldAutoConnect: boolean;
}

export function validateServerUrl(input: string | undefined | null): ServerUrlValidationResult {
  const normalizedUrl = input?.trim() ? input.trim() : DEFAULT_SERVER_URL;

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return { ok: false, message: INVALID_SERVER_URL_MESSAGE };
    }
    return { ok: true, normalizedUrl };
  } catch {
    return { ok: false, message: INVALID_SERVER_URL_MESSAGE };
  }
}

export function resolveServerUrlOrDefault(input: string | undefined | null): string {
  const result = validateServerUrl(input);
  return result.ok ? result.normalizedUrl : DEFAULT_SERVER_URL;
}

export function resolvePersistedServerUrl(input: string | undefined | null): PersistedServerUrlResolution {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) {
    return {
      serverUrl: DEFAULT_SERVER_URL,
      lastError: null,
      shouldAutoConnect: true
    };
  }

  const result = validateServerUrl(trimmed);
  if (result.ok) {
    return {
      serverUrl: result.normalizedUrl,
      lastError: null,
      shouldAutoConnect: true
    };
  }

  return {
    serverUrl: trimmed,
    lastError: result.message,
    shouldAutoConnect: false
  };
}
