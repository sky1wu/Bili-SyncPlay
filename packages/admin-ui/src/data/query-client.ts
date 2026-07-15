import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 请求失败重试一次即可；401 由 http client 统一清会话，重试无意义。
        retry: 1,
        staleTime: 5_000,
      },
    },
  });
}
