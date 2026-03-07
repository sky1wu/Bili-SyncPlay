# Bili-SyncPlay

MVP scaffold for a Chrome extension that synchronizes Bilibili video playback across a room.

## Packages

- `server`: WebSocket room server
- `extension`: Chrome extension (MV3)
- `packages/protocol`: Shared message and state types

## Quick start

```bash
npm install
npm run build
npm run dev:server
```

Load `extension/dist` as an unpacked extension in Chrome.

