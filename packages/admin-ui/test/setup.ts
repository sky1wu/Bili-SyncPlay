import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy*/waitFor 默认 1s，在 CI 覆盖率插桩 + 多 worker 争抢下不够，
// 统一放宽（真正的失败仍会在 10s 内报出，只影响失败用例的等待时长）。
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// antd 的响应式组件依赖 matchMedia / ResizeObserver，jsdom 不提供。
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof globalThis.ResizeObserver !== "function") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
