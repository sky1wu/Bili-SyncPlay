# Admin IP Blacklist Design

## Goal

Add an Admin-managed IP blacklist named `小黑屋`.

Admins can manually add or remove IP addresses, and room detail member rows expose an `加入黑名单` action for a member's current IP address. Adding an IP blocks future WebSocket connections from that IP and immediately disconnects currently connected sessions from the same IP.

## Scope

In scope:

- Add a `小黑屋` menu item in the Admin UI.
- Add Admin API endpoints to list, add, and delete blocked IP addresses.
- Add an `加入黑名单` button to each online member row in room detail when the member has a remote IP.
- Reject blocked IPs during WebSocket upgrade.
- Immediately disconnect all currently online sessions with the blocked IP.
- Record add/delete blacklist operations in audit logs with target type `block`.
- Support both in-memory and Redis-backed storage.

Out of scope:

- CIDR ranges or wildcard matching.
- Automatic expiration.
- Bulk import/export.
- Blocking by user/member token.

## Storage

The blacklist uses a small store interface with memory and Redis implementations.

- Memory mode is for local development and single-process temporary use. Entries are lost when the process restarts.
- Redis mode is the production path. Entries are shared across nodes and survive service restarts as long as Redis keeps the data.
- Redis disk durability depends on the Redis server configuration, such as AOF or RDB. The application will store blacklist entries in Redis, but Redis persistence settings determine whether data survives Redis process or host failures.
- Redis keys should respect the existing Redis namespace helper pattern.

## Admin API

Add endpoints under `/api/admin/ip-blocks`:

- `GET /api/admin/ip-blocks` lists blocked IP addresses.
- `POST /api/admin/ip-blocks` adds one IP address and an optional reason.
- `DELETE /api/admin/ip-blocks/:ip` removes one IP address and accepts an optional reason in the request body.

Write endpoints require the existing Admin write-origin check and at least `operator` role.

Input validation accepts valid IPv4, IPv6, and IPv4-mapped IPv6 values normalized to the same canonical form used by the server security policy.

## Runtime Behavior

When an IP is added:

1. Persist it in the configured blacklist store.
2. Audit the action.
3. Disconnect all current sessions whose normalized `remoteAddress` equals the blocked IP.
4. In multi-node Redis deployments, use the existing Admin command bus pattern so every room node disconnects matching local sessions.

When a client connects:

1. Resolve the remote IP through the existing trusted-proxy logic.
2. Check the blacklist store before accepting the WebSocket upgrade.
3. Reject blocked IPs with HTTP 403 and log a rejected connection event.

Removing an IP only permits future connections. It does not reconnect clients automatically.

## Admin UI

The `小黑屋` page contains:

- A compact add-IP form.
- A table of blocked IPs with created time, actor/reason when available, and delete action.
- Empty and error states matching existing Admin UI patterns.

Room detail online member actions add `加入黑名单` next to existing `踢出成员` and `断开会话`. The button is disabled or omitted when the member has no IP.

## Tests

Use test-first implementation for:

- Store behavior: add/list/delete and duplicate add idempotency.
- Admin API behavior and role protection.
- WebSocket upgrade rejection for blocked IPs.
- Immediate disconnect of existing sessions from a newly blocked IP.
- Admin UI rendering and API method wiring for the `小黑屋` page and room detail button.
