## Why

Bili-SyncPlay already lets room members watch the same Bilibili video in sync, but users still need a separate voice tool to talk while watching. Adding built-in room voice chat keeps the watch-party experience in one place while preserving the existing room, invite, and member model.

## What Changes

- Add room-scoped voice chat backed by a self-hosted LiveKit SFU.
- Restrict rooms to a maximum of 4 members for the voice-enabled experience.
- Let room members hear other voice participants by default after joining the room.
- Keep each user's microphone muted by default; users explicitly toggle the microphone on or off.
- Add a server-side LiveKit token issuance flow that validates the Bili-SyncPlay room and member token before granting LiveKit access.
- Add extension UI and runtime state for voice connection, microphone permission, mute status, remote participant status, and user-visible failures.
- Add LiveKit deployment configuration to the server config layer without exposing LiveKit API secrets to the browser extension.
- Add protocol and runtime contracts for requesting voice access and surfacing voice status.
- Exclude text chat, recording, transcription, moderation tools, and server-side audio forwarding from this change.

## Capabilities

### New Capabilities

- `livekit-voice-chat`: Room-scoped voice chat using self-hosted LiveKit SFU, including token issuance, extension microphone controls, participant voice status, and failure handling.

### Modified Capabilities

- None. There are no existing OpenSpec specs in this repository yet.

## Impact

- `packages/protocol/`: add shared client/server message types, guards, error codes, and protocol version updates for voice access and status messages.
- `server/`: add LiveKit configuration, token generation, room/member validation for voice access, rate limiting, tests, and documentation for required environment variables.
- `extension/`: add LiveKit client integration, voice runtime controller, microphone permission flow, popup controls, state rendering, localization, and browser-target handling for Chrome MV3 and Firefox.
- `README.md`, `README.zh-CN.md`, and operations docs: document LiveKit deployment, environment variables, local development, and production `wss://` requirements.
- External system: requires an operator-managed LiveKit SFU deployment with API key/secret and a browser-accessible WebSocket URL.
