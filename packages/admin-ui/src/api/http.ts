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
        // 携带令牌的请求收到 401 才代表会话失效；未携带令牌的 401
        // （如登录时凭据错误）要保留服务端错误信封，避免误报会话过期。
        if (token) {
          options.onUnauthorized?.();
          throw new ApiError("unauthorized", "登录已失效，请重新登录。", 401);
        }
        throw new ApiError(
          payload?.error?.code ?? "unauthorized",
          payload?.error?.message ?? "登录失败。",
          401,
        );
      }

      // 信封 ok:true 优先于 HTTP 状态码：/readyz 未就绪时返回 503 但
      // 信封仍是 ok:true 的有效数据，调用方需要拿到 status 字段做降级展示。
      if (payload?.ok === true) {
        return payload.data as T;
      }

      throw new ApiError(
        payload?.error?.code ?? "request_failed",
        payload?.error?.message ?? "请求失败。",
        response.status,
      );
    },
  };
}
