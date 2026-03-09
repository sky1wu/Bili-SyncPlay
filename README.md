# Bili-SyncPlay

Bili-SyncPlay is a Chrome extension for synchronized Bilibili watching. Users can create or join a room, share the current video, and keep playback, pause, seek, and playback rate in sync across participants.

This repository is a monorepo with:
- a Chrome extension
- a WebSocket room server
- a shared protocol package

## Features

- Create a room and get a room code
- Join a room with a room code
- Share the current page video from the popup
- Sync play, pause, seek, and playback rate
- Automatically open the currently shared video for room members
- Show in-page room toasts for:
  - member join and leave
  - shared video changes
  - play and pause
  - seek
  - playback rate changes
- Keep non-shared pages local-only while staying in a room
  - non-shared pages do not broadcast playback back to the room
  - manual playback on a non-shared page stays local
- Support multiple Bilibili page types:
  - `https://www.bilibili.com/video/*`
  - `https://www.bilibili.com/bangumi/play/*`
  - `https://www.bilibili.com/festival/*`
  - `https://www.bilibili.com/list/watchlater*`
  - `https://www.bilibili.com/medialist/play/watchlater*`
- Support per-part / per-episode variants:
  - multi-part videos via `?p=`
  - festival pages via `bvid + cid`

## Project Structure

```text
Bili-SyncPlay/
  extension/            Chrome extension
  server/               WebSocket room server
  packages/protocol/    Shared protocol types
  scripts/              Release packaging scripts
  .github/workflows/    GitHub Actions workflows
```

## Requirements

- Node.js 18+
- npm 8+
- Chrome or Edge for loading the unpacked extension

## Local Development

Install dependencies:

```bash
npm install
```

Build everything:

```bash
npm run build
```

Start the local server:

```bash
npm run dev:server
```

Default server URL:

```text
ws://localhost:8787
```

## Load the Extension

1. Run `npm run build` or `npm run build:extension`
2. Open `chrome://extensions`
3. Enable Developer mode
4. Click `Load unpacked`
5. Select `extension/dist`

## Usage

1. Open the extension popup
2. Create a room or join an existing room
3. Open a supported Bilibili video page
4. Click `Sync current page video` in the popup
5. Other room members will open the same video and enter sync mode
6. If a member browses to a different non-shared video while still in the room, that page stays local and does not affect the room unless they explicitly sync it

## Server Deployment

Recommended setup:
- Node.js 20 or 22
- Nginx reverse proxy
- `wss://` server URL for production

The extension supports changing the server URL from the popup, so you can switch from local development to a deployed server such as:

```text
wss://sync.example.com
```

## Build a Release Package

Build the extension release zip:

```bash
npm run build:release
```

Output:

```text
release/bili-syncplay-extension-v<version>.zip
```

## Automated GitHub Release

The repository already includes a GitHub Actions workflow that:
- triggers on `v*` tags
- builds the extension
- creates a GitHub Release
- uploads the zip asset

Example:

```bash
git tag v0.4.1
git push origin v0.4.1
```

## Notes

- Room state is currently stored in server memory only
- Rooms are removed as soon as the last member leaves
- Closing the browser does not restore the previous room automatically
- Bilibili page structures change frequently, so special pages may require future compatibility updates
- Festival pages and watch-later pages rely on URL or page-state extraction that may need maintenance if Bilibili changes those pages

## License

This project is licensed under the GNU General Public License v3.0. See [LICENSE](/d:/workspace/Bili-SyncPlay/LICENSE).
