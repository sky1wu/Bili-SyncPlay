# Contributing

This repository uses a monorepo structure with shared protocol code, a browser extension, and a WebSocket server. The main contribution constraints below are intended to keep structural refactors and new feature work from drifting back into the same maintenance problems that were recently cleaned up.

## Workflow

- Install dependencies before running repository checks: use `npm install` for local development and `npm ci` in CI.
- Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, and `npm test` before merging structural changes.
- When refactoring, update or add regression tests in the same change.
- Keep formatting-only changes separate from behavior changes whenever practical.

## Commit Conventions

- Prefer Conventional Commit style prefixes such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, and `ci:`.
- Keep the subject line concise and focused on the primary change in that commit.
- A single commit should represent one reviewable unit of change.
- Do not hide behavior changes inside `chore:` or `docs:` commits.
- Use `refactor:` only when behavior is intended to stay unchanged; if behavior changes, use a more accurate prefix.

## Structural Constraints

- Keep entry files thin. `index.ts` files should mainly handle bootstrap, wiring, and a small amount of high-level orchestration.
- Before adding more branching logic to an entry file, prefer extracting pure helpers, state stores, or controllers.
- Do not reintroduce large mixed files that combine template strings, DOM updates, business rules, and message dispatch in one place.
- Keep popup rendering, popup actions, and popup state management separated.

## Shared Sources Of Truth

- Shared URL normalization must remain centralized.
- Protocol types and guards must remain centralized under `@bili-syncplay/protocol`.
- Server environment parsing must remain centralized in the server config layer.
- Preserve public import stability for `@bili-syncplay/protocol`; internal refactors should still export through the package root.

## Protocol Changes

Protocol changes are any changes to client/server wire messages, room state fields, playback state fields, shared video fields, error codes, protocol guards, or the meaning of an existing field. Treat removals, renames, type narrowing, required-field changes, and semantic changes as breaking even when TypeScript can compile locally.

Keep protocol edits centered on these sources of truth:

- `packages/protocol/src/types/common.ts` for the extension/client `PROTOCOL_VERSION`.
- `server/src/messages.ts` for `CURRENT_PROTOCOL_VERSION` and `MIN_PROTOCOL_VERSION`.
- `packages/protocol/src/types/` and `packages/protocol/src/guards/` for message/domain shapes and validation.
- Extension popup/user-facing messages in `extension/src/shared/i18n.ts` when old clients can be rejected or users need upgrade guidance.

Use this checklist for every PR that adds, removes, renames, retypes, or changes the semantics of a protocol field:

- Classify the change as additive/backward compatible or breaking in the PR description.
- Bump `PROTOCOL_VERSION` in `packages/protocol/src/types/common.ts` and `CURRENT_PROTOCOL_VERSION` in `server/src/messages.ts` for every wire-shape or semantic protocol change.
- Decide whether `MIN_PROTOCOL_VERSION` must also be bumped. Leave it at the previous accepted version when the server can still safely handle old clients.
- When `MIN_PROTOCOL_VERSION` changes, update the unsupported-version user prompt and any popup state that surfaces upgrade guidance.
- Update protocol type-guard tests for both accepted and rejected payloads.
- Update the server protocol-version test matrix for `room:create`, `room:join`, legacy clients without `protocolVersion`, and clients below the minimum supported version.
- Update extension tests for every message path that sends `protocolVersion`.
- Document the compatibility window and rollout order in the PR description.

Compatibility policy:

- Prefer additive changes that let the server accept the previous released protocol version while new clients roll out.
- Keep `MIN_PROTOCOL_VERSION` lower than or equal to the previous released extension protocol version until old clients are intentionally retired.
- Raise `MIN_PROTOCOL_VERSION` only in a follow-up PR or release step after documenting why old clients can no longer be supported.
- Security, data-loss, or server-safety fixes may shorten the compatibility window, but the PR must state the reason and include the user-facing upgrade prompt update.

## Testing Focus

Refactors that touch these areas should include regression coverage:

- extension sync flow
- popup state and rendering flow
- server config loading
- protocol validation
- server room lifecycle and admin routing

## Documentation

- Update `README.md` and `README.zh-CN.md` when developer-facing commands or workflows change.
- Update relevant files under `docs/` when a structural refactor changes the intended architecture or module boundaries.
