## Verification

Date: 2026-06-02

### Passed

- Focused protocol tests: `npm run --ignore-scripts test -w @bili-syncplay/protocol`
  - Result: passed, 81 tests.
- Focused server voice and related lifecycle tests:
  - `npx tsx --test server/test/voice-service.test.ts server/test/voice-capacity.test.ts server/test/message-validation.ts server/test/room-event-consumer.test.ts server/test/config-env.test.ts server/test/runtime-config.test.ts server/test/room-service.test.ts`
  - Result: passed, 145 tests.
- Focused extension voice and popup state tests:
  - `npx tsx --test extension/test/voice-controller.test.ts extension/test/popup-render.test.ts extension/test/popup-save-server-url.test.ts extension/test/popup-bus.test.ts extension/test/popup-state-sync.test.ts extension/test/state-store.test.ts extension/test/room-session-controller.test.ts`
  - Result: passed, 39 tests.
- Root typecheck: `npm run typecheck`
  - Result: passed.
- Root build: `npm run build`
  - Result: passed.
- Root test suite: `npm test`
  - Result: passed.
- Firefox target build: `npm run build:extension:firefox`
  - Result: passed.
  - Checked `extension/dist-firefox/manifest.json`: Firefox output does not include the Chrome-only `offscreen` permission.
- Focused microphone permission window regression tests:
  - `npx tsx --test extension/test/microphone-permission-controller.test.ts extension/test/message-controller.test.ts extension/test/voice-controller.test.ts extension/test/popup-save-server-url.test.ts extension/test/popup-render.test.ts`
  - Result: passed, 32 tests.
- Extension typecheck after microphone permission-window change: `npm run typecheck -w @bili-syncplay/extension`
  - Result: passed.
- Chrome extension build after microphone permission-window change: `npm run build:extension`
  - Result: passed.
  - Checked `extension/dist`: `voice-permission.html`, `voice-permission.css`, `voice-permission.js`, and source map are present.
- External LiveKit backend smoke against the user-provided LiveKit endpoint
  - Result: passed.
  - Verified LiveKit server API authentication with `RoomServiceClient.listRooms`.
  - Started a temporary local Bili-SyncPlay server with voice enabled.
  - Created a room through WebSocket, joined a second member, requested `voice:access` for both members, and verified participant identities map to Bili-SyncPlay member ids.
  - Verified the issued LiveKit token can open the LiveKit `/rtc` WebSocket handshake.
  - Verified `voice:state` from one member is broadcast to the other room member.

### Skipped Browser LiveKit Smoke

The real browser-side LiveKit integration smoke was not run in this local session because it still requires loaded browser extension clients with microphone permission prompts and remote audio playback.

Required setup before running the skipped smoke:

- Start the Bili-SyncPlay server with:
  - `VOICE_ENABLED=true`
  - `LIVEKIT_URL=wss://<livekit-host>`
  - `LIVEKIT_API_KEY=$LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET`
- Load the Chrome extension build from `extension/dist` and the Firefox extension build from `extension/dist-firefox`, or run the target browser under an equivalent extension smoke harness.
- Join one room with at least two clients and verify:
  - room join obtains voice access after valid room membership;
  - remote voice is audible or reports browser audio interaction required;
  - microphone permission is not requested on join;
  - denying microphone permission keeps playback sync connected and leaves the user muted;
  - enabling and disabling the mic updates local publish state and room member voice indicators;
  - leaving or changing rooms disconnects LiveKit and clears voice state.
