export type AdminUiRuntimeConfig = {
  demoEnabled: boolean;
  apiBaseUrl: string;
};

export function normalizeAdminUiConfig(value: unknown): AdminUiRuntimeConfig {
  if (!value || typeof value !== "object") {
    return { demoEnabled: false, apiBaseUrl: "" };
  }

  const record = value as Record<string, unknown>;
  return {
    demoEnabled: record.demoEnabled === true,
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
