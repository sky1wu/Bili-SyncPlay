export type AdminUiRuntimeConfig = {
  apiBaseUrl: string;
};

export function normalizeAdminUiConfig(value: unknown): AdminUiRuntimeConfig {
  if (!value || typeof value !== "object") {
    return { apiBaseUrl: "" };
  }

  const record = value as Record<string, unknown>;
  return {
    apiBaseUrl:
      typeof record.apiBaseUrl === "string"
        ? record.apiBaseUrl.replace(/\/+$/, "")
        : "",
  };
}

export function readAdminUiConfig(): AdminUiRuntimeConfig {
  const injected = (globalThis as { __ADMIN_UI_CONFIG__?: unknown })
    .__ADMIN_UI_CONFIG__;
  return normalizeAdminUiConfig(injected);
}
