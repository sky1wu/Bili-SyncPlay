// 与旧管理面板共用同一个 key，新旧 UI 的登录会话互通。
const STORAGE_KEY = "bili-syncplay-admin-token";

export function getStoredToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

export function setStoredToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}
