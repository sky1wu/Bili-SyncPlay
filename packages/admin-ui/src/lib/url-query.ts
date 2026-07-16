import { useSearchParams } from "react-router-dom";

export type UrlQueryPatch = Record<
  string,
  string | number | boolean | undefined
>;

/**
 * 以 URL 查询串为筛选状态的唯一来源：patch 里等于默认值或为空的键
 * 从地址栏移除，保持链接干净可分享。
 */
export function useUrlQueryState(defaults: Record<string, string>) {
  const [searchParams, setSearchParams] = useSearchParams();

  const updateQuery = (patch: UrlQueryPatch) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      const serialized = value === undefined ? "" : String(value);
      if (serialized === "" || serialized === defaults[key]) {
        next.delete(key);
      } else {
        next.set(key, serialized);
      }
    }
    setSearchParams(next, { replace: true });
  };

  return { searchParams, updateQuery };
}

export function readPositiveInt(
  params: URLSearchParams,
  key: string,
  fallback: number,
): number {
  const value = Number(params.get(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function readTimestamp(
  params: URLSearchParams,
  key: string,
): number | undefined {
  const value = Number(params.get(key));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
