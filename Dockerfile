# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app

# npm workspaces 安装要求所有成员的 package.json 在位（含 extension，仅清单不拷源码）。
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
COPY extension/package.json extension/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/protocol/tsconfig.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build -w @bili-syncplay/protocol && npm run build -w @bili-syncplay/server

# 重装仅生产依赖（ws、ioredis 及 workspace 链接），供运行阶段拷贝。
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# node_modules 中的 @bili-syncplay/protocol 是指向 packages/protocol 的
# workspace 软链接，因此运行阶段必须保留同样的目录布局。
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/packages/protocol/package.json packages/protocol/
COPY --from=builder /app/packages/protocol/dist packages/protocol/dist
COPY --from=builder /app/server/package.json server/
COPY --from=builder /app/server/dist server/dist
# 服务端按 dist/../admin-ui 解析管理面板静态资源。
COPY server/admin-ui server/admin-ui

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8787}/healthz" >/dev/null || exit 1

CMD ["node", "server/dist/index.js"]
