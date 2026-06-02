## 1. Protocol Contracts

- [x] 1.1 Add voice access, voice status, and voice error message types under `packages/protocol/src/types/`.
- [x] 1.2 Add protocol guards and negative validation cases for LiveKit token responses, voice status, and voice errors.
- [x] 1.3 Add voice-related error codes such as voice unavailable, voice capacity reached, and voice token failure.
- [x] 1.4 Bump `PROTOCOL_VERSION` and `CURRENT_PROTOCOL_VERSION`, and decide whether `MIN_PROTOCOL_VERSION` can stay compatible.
- [x] 1.5 Update protocol tests for accepted and rejected voice messages.

## 2. Server Configuration And Token Issuance

- [x] 2.1 Add LiveKit voice config fields to the server config layer, including URL, API key, API secret, enabled flag, token TTL, and max voice members.
- [x] 2.2 Add a server-side LiveKit token service that signs room-scoped tokens without exposing API secrets.
- [x] 2.3 Add room/member validation for voice access using existing room code and member token semantics.
- [x] 2.4 Enforce an effective four-member room limit when voice is enabled, including concurrent join coverage.
- [x] 2.5 Wire voice access handling into the existing WebSocket message handler and logging/metrics style.
- [x] 2.6 Add server tests for enabled, disabled, missing-secret, invalid-member, valid-member, and room-full voice flows.

## 3. Extension Voice Runtime

- [x] 3.1 Add LiveKit client dependency and isolate all LiveKit usage behind a voice runtime adapter.
- [x] 3.2 Create a background voice controller that requests server voice access, tracks room lifecycle, and exposes popup state.
- [x] 3.3 Implement a browser media host for LiveKit connection, remote audio playback, microphone capture, and local audio publish/unpublish.
- [x] 3.4 Verify and document the Chrome MV3 and Firefox media hosting path before relying on it in production behavior.
- [x] 3.5 Keep microphone muted by default and request microphone permission only after the user toggles the mic on.
- [x] 3.6 Disconnect and clear voice state when leaving a room, changing rooms, or losing valid room membership.
- [x] 3.7 Add extension unit tests for voice state transitions, token request routing, mute toggles, and failure recovery.

## 4. Popup UI And Localization

- [x] 4.1 Add a compact voice section to the popup with voice availability, connection state, and a mic toggle.
- [x] 4.2 Show participant voice indicators in the member list without mixing rendering, actions, and state logic.
- [x] 4.3 Add localized Chinese and English strings for voice status, permission denial, unavailable service, and connection failure.
- [x] 4.4 Add popup rendering and action tests for voice unavailable, connected, muted, unmuted, and failed states.

## 5. Documentation And Deployment

- [x] 5.1 Document self-hosted LiveKit deployment assumptions and required server environment variables.
- [x] 5.2 Update README files with voice setup, local development, production `wss://` guidance, and rollback by disabling voice config.
- [x] 5.3 Update operations docs for LiveKit URL, API secret handling, room capacity, and troubleshooting.
- [x] 5.4 Ensure examples keep secrets as environment-variable placeholders and never commit real LiveKit credentials.

## 6. Verification

- [x] 6.1 Run focused protocol, server, and extension tests for the voice change.
- [x] 6.2 Run `npm run typecheck`.
- [x] 6.3 Run `npm run build`.
- [x] 6.4 Run `npm test`.
- [ ] 6.5 Run browser-side smoke for room join, default listening, mic permission denial, mic toggle, and room leave cleanup.
- [x] 6.6 Record any skipped LiveKit integration checks and the required external LiveKit setup.
