import { isPageShareButtonSettingsResponse } from "../shared/messages";

export type PageShareButtonSettingsHydrationResult =
  | { action: "apply"; enabled: boolean }
  | { action: "retry" }
  | { action: "give-up" };

export function resolvePageShareButtonSettingsHydration(
  response: unknown,
  attempt: number,
  maxAttempts: number,
): PageShareButtonSettingsHydrationResult {
  if (isPageShareButtonSettingsResponse(response) && response.ok) {
    return { action: "apply", enabled: response.enabled };
  }
  if (attempt < maxAttempts) {
    return { action: "retry" };
  }
  return { action: "give-up" };
}
