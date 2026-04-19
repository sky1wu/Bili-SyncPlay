# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

- Respond in Chinese (中文) unless the user explicitly writes in another language.

## Git Workflow

- ALWAYS create a feature branch before making changes; NEVER push directly to main.
- ALWAYS run `format:check` / full pre-commit check sequence BEFORE pushing commits to avoid CI failures.
- After addressing review feedback, re-verify related code paths for similar issues (e.g., state cleanup, error handling) before declaring the fix complete.

## Review Feedback Process

- When addressing Codex/reviewer feedback, audit ALL related code paths for the same class of bug, not just the specific line flagged.
- For state-cleanup/reset functions, grep for every piece of related state and verify each is handled.
- For async Redis/lock operations, always `await` and wrap in try/catch to avoid orphan locks or race conditions.

## Project Overview

Bili-SyncPlay is a monorepo for synchronized Bilibili video playback across multiple users. It consists of:

- **`packages/protocol/`** — Shared TypeScript types, type guards, and URL normalization utilities
- **`extension/`** — Chrome/Edge browser extension (service worker + content scripts + popup)
- **`server/`** — Node.js WebSocket server with admin panel

## Commands

```bash
# Install dependencies
npm install

# Build all packages (protocol → server + extension, in dependency order)
npm run build

# Development server (watch mode)
npm run dev:server

# Build extension only
npm run build:extension

# Code quality checks
npm run lint
npm run lint:fix
npm run format:check
npm run typecheck

# Testing
npm test
npm run coverage

# Release
npm run build:release    # Package extension
npm run release:version  # Bump version numbers
```

**Before every commit**, run in order:

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test
```

## Architecture

### Data Flow

1. Content script detects Bilibili video playback changes
2. Sends to background service worker via `chrome.runtime.sendMessage`
3. Background worker validates, updates room state, forwards to WebSocket server
4. Server broadcasts to all room members
5. Other clients receive the message and apply playback state to their video player

### Key Extension Controllers (`extension/src/background/`)

| Controller                   | Responsibility                                         |
| ---------------------------- | ------------------------------------------------------ |
| `socket-controller.ts`       | WebSocket connection, reconnection, health checks      |
| `room-session-controller.ts` | Room create/join/leave/state                           |
| `share-controller.ts`        | Shared video and pending local shares                  |
| `clock-controller.ts`        | NTP-style clock offset for playback sync               |
| `tab-controller.ts`          | Bilibili tab tracking, shared vs. local page switching |
| `message-controller.ts`      | Routes popup/content messages to handlers              |

The `background/index.ts` entry file only bootstraps and wires controllers — keep it thin.

### Server (`server/src/`)

- `app.ts` — HTTP/WebSocket setup and message routing
- `config/` — Centralized environment parsing (`ALLOWED_ORIGINS`, `PORT`, `REDIS_URL`)
- `admin/` — Admin panel, command bus, event store, session management

Optional Redis support enables multi-node deployments.

### Protocol Package (`packages/protocol/`)

Single source of truth for `ClientMessage`, `ServerMessage`, domain types (`RoomState`, `SharedVideo`, `PlaybackState`, `RoomMember`), type guards, and URL normalization. Always export through the package root to preserve import stability.

## Structural Constraints

- `index.ts` files: bootstrap and wiring only; extract logic to controllers/helpers/stores
- Do not combine templates, DOM updates, business rules, and message dispatch in one file
- Separate popup rendering, actions, and state management
- URL normalization must stay centralized (`normalizeSharedVideoUrl`)
- Protocol types/guards must stay in `@bili-syncplay/protocol`
- Server env parsing must stay in the server config layer

## Commit Conventions

Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:`

- One reviewable unit per commit
- `refactor:` only when behavior is unchanged
- Do not hide behavior changes in `chore:` or `docs:`

## Testing Focus

Refactors touching these areas require regression coverage:

- Extension sync flow
- Popup state and rendering flow
- Server config loading
- Protocol validation (type guards)
- Server room lifecycle and admin routing
