export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
};

export type HttpClient = {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
};

export type HttpClientOptions = {
  baseUrl?: string;
  getToken: () => string;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
};

type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async request<T>(path: string, requestOptions: RequestOptions = {}) {
      const token = options.getToken();
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: requestOptions.method ?? "GET",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(requestOptions.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        body:
          requestOptions.body !== undefined
            ? JSON.stringify(requestOptions.body)
            : undefined,
      });

      const contentType = response.headers.get("content-type") ?? "";
      const payload: ApiEnvelope<T> | null = contentType.includes(
        "application/json",
      )
        ? await response.json()
        : null;

      if (response.status === 401) {
        options.onUnauthorized?.();
        throw new ApiError("unauthorized", "登录已失效，请重新登录。", 401);
      }

      if (!response.ok || payload?.ok !== true) {
        throw new ApiError(
          payload?.error?.code ?? "request_failed",
          payload?.error?.message ?? "请求失败。",
          response.status,
        );
      }

      return payload.data as T;
    },
  };
}
