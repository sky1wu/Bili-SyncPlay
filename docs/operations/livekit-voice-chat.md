# LiveKit Voice Chat Operations

This guide covers the optional room voice feature backed by a self-hosted LiveKit SFU.

## Scope

- Voice is optional. Playback sync continues when voice is disabled or misconfigured.
- Bili-SyncPlay issues room-scoped LiveKit tokens after validating the existing `memberToken`.
- LiveKit API key and secret are server-side only. Never put them in extension builds, JSON config files, docs examples with real values, or client logs.
- When voice is enabled, the effective room capacity is capped at 4 members, even if `MAX_MEMBERS_PER_ROOM` is higher.

## Required Server Configuration

Non-secret settings can live in `server.config.json`:

```json
{
  "voice": {
    "enabled": true,
    "livekitUrl": "wss://voice.example.com",
    "tokenTtlSeconds": 900,
    "maxMembers": 4
  }
}
```

Secrets must stay in environment variables:

```bash
VOICE_ENABLED=true
LIVEKIT_URL=wss://voice.example.com
LIVEKIT_API_KEY=$LIVEKIT_API_KEY
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
VOICE_TOKEN_TTL_SECONDS=900
VOICE_MAX_MEMBERS=4
```

`LIVEKIT_URL` must be browser-reachable and use `wss://` in production. `ws://` is only suitable for local development. To roll back voice without changing playback sync, set `VOICE_ENABLED=false` or remove the LiveKit URL/key/secret.

## Browser Media Host

- Chrome/Edge MV3: the extension creates `offscreen.html` through the `chrome.offscreen` API with `AUDIO_PLAYBACK`, `USER_MEDIA`, and `WEB_RTC` reasons. The service worker owns room state and token requests; the offscreen document owns LiveKit, remote audio elements, and microphone capture.
- Firefox: the Firefox build removes the Chrome-only `offscreen` permission and uses the extension background page context as the compatible media host.
- The popup only sends microphone toggle commands. It does not hold the LiveKit connection, so closing the popup does not end voice.

## Local Smoke Checklist

1. Start LiveKit and the Bili-SyncPlay server with placeholder-free environment variables.
2. Build both browser targets:

```bash
npm run build:extension
npm run build:extension:firefox
```

3. Join a room with two extension instances.
4. Confirm the voice section reaches connected state.
5. Confirm no microphone permission prompt appears on join.
6. Click the mic button, grant or deny permission, and confirm the popup reflects the result.
7. Leave or change rooms and confirm voice state returns to idle.

## Troubleshooting

- `voice_unavailable`: voice is disabled, LiveKit URL/key/secret is missing, or `LIVEKIT_URL` is invalid.
- `voice_token_failed`: the server could not sign a LiveKit token. Check `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.
- Room full at 4 members: expected when voice is enabled. Disable voice to return to the non-voice room capacity.
- Remote audio does not play: browser autoplay policy may require user interaction; use the popup and inspect the extension/offscreen logs.
- Microphone denied: the user remains connected as a listener and can retry from the mic button after changing browser permissions.
