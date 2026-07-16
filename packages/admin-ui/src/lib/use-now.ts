import { useEffect, useState } from "react";

/** 以 intervalMs 为周期返回当前时间戳；enabled 为 false 时停表不重渲染。 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handle = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [intervalMs, enabled]);

  return now;
}
