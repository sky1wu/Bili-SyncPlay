import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createAdminApi } from "../api/admin-api.js";
import type { AdminApi } from "../api/admin-api.js";
import { ApiError, createHttpClient } from "../api/http.js";
import type { AdminIdentity } from "../api/types.js";
import { readAdminUiConfig } from "../config.js";
import {
  clearStoredToken,
  getStoredToken,
  setStoredToken,
} from "./token-store.js";

export type AuthContextValue = {
  token: string;
  me: AdminIdentity | null;
  initializing: boolean;
  meError: string;
  api: AdminApi;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  retryLoadMe: () => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState(() => getStoredToken());
  const [me, setMe] = useState<AdminIdentity | null>(null);
  const [meError, setMeError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [initializing, setInitializing] = useState(
    () => getStoredToken() !== "",
  );

  const clearSession = useCallback(() => {
    clearStoredToken();
    setTokenState("");
    setMe(null);
    setMeError("");
  }, []);

  const api = useMemo(() => {
    const config = readAdminUiConfig();
    return createAdminApi(
      createHttpClient({
        baseUrl: config.apiBaseUrl,
        getToken: getStoredToken,
        onUnauthorized: clearSession,
      }),
    );
  }, [clearSession]);

  useEffect(() => {
    if (!token || me) {
      setInitializing(false);
      return;
    }

    let cancelled = false;
    api
      .getMe()
      .then((result) => {
        if (!cancelled) {
          setMe({
            id: result.id,
            username: result.username,
            role: result.role,
          });
          setMeError("");
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        // 401 已由 http client 的 onUnauthorized 回调清理会话；
        // 其它失败（网络抖动、5xx）保留本地令牌，仅记录错误供重试。
        if (!(cause instanceof ApiError && cause.status === 401)) {
          setMeError(
            cause instanceof Error ? cause.message : "管理员身份校验失败。",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setInitializing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, token, me, loadAttempt]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const result = await api.login({ username, password });
      setStoredToken(result.token);
      setTokenState(result.token);
      setMe(result.admin);
    },
    [api],
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 登出接口失败不阻塞本地会话清理。
    }
    clearSession();
  }, [api, clearSession]);

  const retryLoadMe = useCallback(() => {
    setMeError("");
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const value = useMemo(
    () => ({
      token,
      me,
      initializing,
      meError,
      api,
      signIn,
      signOut,
      retryLoadMe,
    }),
    [token, me, initializing, meError, api, signIn, signOut, retryLoadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth 必须在 AuthProvider 内使用。");
  }
  return value;
}
