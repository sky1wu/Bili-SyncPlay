# Admin IP Blacklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Admin-managed `小黑屋` IP blacklist that blocks future WebSocket connections and immediately disconnects current sessions from blocked IPs.

**Architecture:** Introduce a focused blacklist store interface with memory and Redis implementations, wire it into Admin services and the WebSocket upgrade path, and expose management controls through the existing Admin UI. Redis mode shares blacklist entries across nodes and relies on Redis AOF/RDB for disk durability.

**Tech Stack:** Node.js, TypeScript, `ws`, `ioredis`, built-in `node:test`, Admin UI plain JavaScript.

---

### Task 1: Store And IP Normalization

**Files:**

- Create: `server/src/ip-address.ts`
- Create: `server/src/admin/ip-block-store.ts`
- Create: `server/src/admin/redis-ip-block-store.ts`
- Modify: `server/src/redis-namespace.ts`
- Test: `server/test/ip-block-store.test.ts`

- [ ] Write failing tests for IP normalization and memory store add/list/delete behavior.
- [ ] Run `npm run --ignore-scripts test -w @bili-syncplay/server -- server/test/ip-block-store.test.ts` and verify missing modules/functions fail.
- [ ] Implement `normalizeIpAddress`, `createInMemoryIpBlockStore`, and the `IpBlockStore` types.
- [ ] Implement `createRedisIpBlockStore` with namespace-aware Redis keys.
- [ ] Run the focused test and verify it passes.

### Task 2: Admin API And Action Service

**Files:**

- Modify: `server/src/admin/types.ts`
- Modify: `server/src/admin/router-types.ts`
- Modify: `server/src/admin/routes/read-routes.ts`
- Modify: `server/src/admin/routes/action-routes.ts`
- Modify: `server/src/admin/action-service.ts`
- Modify: `server/src/bootstrap/admin-services.ts`
- Test: `server/test/admin-ip-blocks.test.ts`

- [ ] Write failing tests for `GET /api/admin/ip-blocks`, `POST /api/admin/ip-blocks`, and `DELETE /api/admin/ip-blocks/:ip`.
- [ ] Verify write routes require existing write-origin and `operator` role behavior.
- [ ] Add action service methods `blockIp` and `unblockIp`.
- [ ] Validate IP input with the shared normalizer and return a 400 admin error for invalid IPs.
- [ ] Audit add/delete operations with `targetType: "block"`.
- [ ] Run the focused test and verify it passes.

### Task 3: Upgrade Rejection And Immediate Disconnect

**Files:**

- Modify: `server/src/security.ts`
- Modify: `server/src/ws-session-handler.ts`
- Modify: `server/src/admin-command-bus.ts`
- Modify: `server/src/admin-command-consumer.ts`
- Modify: `server/src/bootstrap/admin-services.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/global-admin-app.ts`
- Test: `server/test/ip-blacklist-runtime.test.ts`

- [ ] Write failing tests that a blocked IP is rejected during WebSocket upgrade with 403.
- [ ] Write failing tests that adding an IP disconnects current matching sessions.
- [ ] Add a blacklist check to the upgrade path before accepting WebSocket sessions.
- [ ] Add an admin command kind for disconnecting local sessions by IP so Redis multi-node deployments fan out the disconnect.
- [ ] Wire the blacklist store into room-node and global-admin bootstraps.
- [ ] Run the focused runtime test and verify it passes.

### Task 4: Admin UI

**Files:**

- Modify: `server/admin-ui/api.js`
- Modify: `server/admin-ui/app-runtime.js`
- Modify: `server/admin-ui/page-renderers.js`
- Modify: `server/admin-ui/render-utils.js`
- Modify: `server/admin-ui/state.js`
- Modify: `server/admin-ui/demo-data.js`
- Modify: `server/admin-ui/styles.css`
- Test: `server/test/admin-ui-page-renderers.test.ts`
- Test: `server/test/admin-ui-runtime.test.ts`

- [ ] Write failing UI tests for the `小黑屋` nav/page and room detail `加入黑名单` member action.
- [ ] Add API methods `listIpBlocks`, `blockIp`, and `unblockIp`.
- [ ] Add route metadata and nav entry for `/ip-blocks`.
- [ ] Render add form, table, delete action, empty state, and demo data.
- [ ] Add member row `加入黑名单` button only when `remoteAddress` is present.
- [ ] Bind the new page and member action to the Admin API with confirmation dialog.
- [ ] Run focused UI tests and verify they pass.

### Task 5: Verification And Docs

**Files:**

- Modify: `README.zh-CN.md`
- Modify: `README.md`
- Test: package scripts

- [ ] Add a short Admin blacklist section documenting Redis persistence responsibility and Redis AOF/RDB note.
- [ ] Run `npm run lint`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm test`.
- [ ] Run `npm run format:check` and record the known baseline formatting failure if still present.
