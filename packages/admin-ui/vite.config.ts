import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const DEV_SERVER_TARGET = "http://localhost:8787";

export default defineConfig({
  base: "/admin-next/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: DEV_SERVER_TARGET,
        changeOrigin: true,
        // 管理端写接口有同源 Origin 校验，代理时把 Origin 改写为目标源，
        // 否则 dev server（5173）发起的登录等 POST 会被拒绝。
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", DEV_SERVER_TARGET);
          });
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
