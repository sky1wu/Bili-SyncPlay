import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";

const DEV_SERVER_TARGET = "http://localhost:8787";

// 管理端写接口有同源 Origin 校验，代理时把 Origin 改写为目标源，
// 否则 dev server（5173）发起的登录等 POST 会被拒绝。
const devProxyEntry: ProxyOptions = {
  target: DEV_SERVER_TARGET,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq) => {
      proxyReq.setHeader("origin", DEV_SERVER_TARGET);
    });
  },
};

export default defineConfig({
  base: "/admin-next/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": devProxyEntry,
      // 健康检查在根路径，不代理的话 dev 模式下概览页会误报 readyz 降级。
      "/readyz": devProxyEntry,
      "/healthz": devProxyEntry,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // antd 组件交互测试（userEvent + 弹窗/下拉）在 CI 覆盖率插桩 +
    // 多 worker 争抢下明显变慢，放宽超时作为兜底；主要提速手段是
    // 测试里 userEvent.setup({ delay: null }) 关闭逐键延迟。
    testTimeout: 30_000,
  },
});
