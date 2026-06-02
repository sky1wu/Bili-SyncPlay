## Context

Bili-SyncPlay is a browser extension plus Node.js WebSocket server for synchronized Bilibili playback. The existing server owns room creation, joining, member tokens, playback state, and room broadcasts. The extension owns popup interaction, background WebSocket connection, content-script playback observation, and persisted room state.

Voice chat introduces a media plane that the current WebSocket server should not carry. The confirmed direction is to run an operator-managed LiveKit SFU and use the Bili-SyncPlay server as the authority that decides which room members may receive LiveKit access tokens.

Key constraints:

- Room voice chat is part of the room experience, not a separate channel users join manually.
- Users can hear voice in the room by default after joining.
- Microphones are muted by default and require an explicit user action to unmute.
- Voice-enabled rooms are limited to 4 members.
- LiveKit API keys and secrets must never be sent to the browser extension.
- Protocol changes must follow the repository protocol-version policy.

## Goals / Non-Goals

**Goals:**

- Add room-scoped voice chat using self-hosted LiveKit SFU.
- Keep Bili-SyncPlay as the business authority for room membership, member tokens, and voice access.
- Add a server token issuance flow that maps a Bili-SyncPlay room to a LiveKit room and a member to a LiveKit participant.
- Add extension-side voice runtime state, LiveKit connection management, remote audio playback, and microphone controls.
- Surface voice connection, mute, permission, and participant status in the popup.
- Keep voice optional at deployment time: playback sync must still work when LiveKit config is absent or disabled.

**Non-Goals:**

- Text chat, recording, transcription, moderation tools, push-to-talk shortcuts, device selection, and noise suppression tuning.
- Server-side audio forwarding through the existing WebSocket server.
- Hosting or provisioning LiveKit from inside this repository.
- Supporting more than 4 room members for the initial voice-enabled release.

## Decisions

### Use LiveKit SFU for the media plane

Use a self-hosted LiveKit deployment for audio transport. Each browser extension connects to LiveKit with a short-lived token issued by the Bili-SyncPlay server. LiveKit handles audio publish/subscribe, SFU routing, ICE/NAT behavior, and media reconnect behavior.

Alternatives considered:

- WebRTC mesh: lower server dependency, but each client uploads to every other member and becomes inefficient as room size grows.
- Existing WebSocket audio forwarding: rejected because it would require rebuilding low-latency audio transport, jitter handling, encoding, and backpressure.
- mediasoup: powerful but lower-level than LiveKit and heavier for this project's first voice implementation.

### Keep the Bili-SyncPlay server as voice authority

Add a server-side voice access path that accepts the current room/member token, validates membership through the existing room service, and returns `{ livekitUrl, token, roomName, participantIdentity }`. The server uses LiveKit API key/secret from the server config layer to sign access tokens.

LiveKit room names should derive from the sync room code, for example `bili-syncplay:<roomCode>`. LiveKit participant identity should be the Bili-SyncPlay `memberId`, and the participant display name should follow the existing room display name.

Alternatives considered:

- Let the extension create LiveKit tokens directly: rejected because it would expose LiveKit API secrets.
- Use a separate auth service: unnecessary for the current monorepo; it would duplicate room/member validation.
- Manually manage LiveKit rooms in a persistent database: not needed for the initial flow because rooms can be created lazily by token-based joins.

### Enforce a 4-member voice-enabled room limit

When voice is enabled, the effective room member limit is 4. This should be enforced by server-side join behavior so popup, playback sync, and voice all share the same capacity boundary. If existing deployment config sets a larger `MAX_MEMBERS_PER_ROOM`, the voice-enabled effective limit should cap it at 4 unless a future change explicitly revisits that policy.

Alternatives considered:

- Keep 8 playback members and only allow 4 voice participants: rejected for MVP because it creates a confusing split where some members can watch but not talk.
- Make the limit purely client-side: rejected because capacity must be authoritative under concurrent joins.

### Add protocol messages for voice access and status

Use the shared protocol package as the source of truth. Add client/server messages for requesting voice access and receiving token or status responses. Add error codes for LiveKit unavailable, voice capacity reached, token issuance failure, and microphone/permission-state reporting where server-visible.

This is a wire-shape change, so `PROTOCOL_VERSION` and `CURRENT_PROTOCOL_VERSION` must be bumped. `MIN_PROTOCOL_VERSION` should remain compatible unless an implementation detail makes old clients unsafe.

Alternatives considered:

- Add ad hoc extension-only runtime messages without protocol types: rejected because server/client wire contracts belong in `@bili-syncplay/protocol`.
- Use a new HTTP endpoint only for tokens: possible, but reusing the existing WebSocket session keeps room authentication, origin checks, logging, and reconnection behavior aligned with current architecture.

### Split extension voice runtime from popup rendering

The popup should present controls and status only. A new background-side voice controller should coordinate room membership, token requests, and high-level voice state. A browser-capable voice runtime document should own LiveKit client connection, microphone capture, local audio publication, and remote audio playback because the Chrome MV3 service worker cannot be treated as a long-lived DOM/media owner.

Chrome should use an offscreen document or equivalent extension page for media work. Firefox should use the existing event-page target shape or a compatible extension page path. The implementation must prove the chosen browser-specific hosting path with real extension smoke tests.

Alternatives considered:

- Host LiveKit in the popup: rejected because popup lifetime is too short and it closes during normal use.
- Host LiveKit in the Bilibili content script: rejected because voice should be room-level, not tied to a single video tab or page lifecycle.
- Host LiveKit only in the background service worker: risky for Chrome MV3 because media playback/capture needs a durable browser context.

### Keep microphone muted by default

Joining a room should start or prepare receive-side voice without publishing the microphone. A user click on the microphone control triggers permission request and local audio publication. Toggling off should stop or unpublish the local microphone track and broadcast mute status.

Alternatives considered:

- Prompt for microphone immediately on room join: rejected because it surprises users and is not needed for listening.
- Auto-unmute after permission was previously granted: rejected for MVP because explicit user intent is clearer.

### Treat LiveKit as optional deployment config

Add server config fields such as `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `VOICE_ENABLED`, and `VOICE_MAX_MEMBERS` through the existing config layer. Voice UI should report unavailable/disabled when the server cannot issue voice access. Playback sync should continue to work without LiveKit.

Alternatives considered:

- Require LiveKit for all deployments after the change: rejected because existing playback-only self-hosted deployments should remain usable.
- Embed LiveKit defaults in extension builds: rejected because deployment secrets and URLs are server-owned.

## Risks / Trade-offs

- [Browser extension media context differs across Chrome MV3 and Firefox] -> Build the voice runtime behind a small browser-target abstraction and verify with real extension smoke tests.
- [Autoplay or audio-output restrictions may prevent remote audio playback] -> Use user-initiated popup controls to start voice and expose a clear "voice needs user action" state if playback is blocked.
- [LiveKit deployment or TURN configuration is incomplete] -> Make voice unavailable with a user-visible error while leaving playback sync connected.
- [Token leakage could allow joining a LiveKit room briefly] -> Issue short-lived tokens scoped to one room and one participant identity, and never expose API secrets.
- [Room capacity changes can affect existing deployments] -> Cap only voice-enabled deployments at 4 members and document the rollout behavior.
- [Protocol changes could break old clients] -> Keep additive messages, bump current protocol version, retain minimum compatibility unless unsafe, and update the protocol test matrix.
- [Popup becomes crowded] -> Add a compact voice section with a single mic toggle, status, and small participant indicators instead of expanding advanced diagnostics.

## Migration Plan

1. Add config fields and docs for self-hosted LiveKit without enabling voice unless the required config is present.
2. Add protocol contracts and server token issuance behind the voice-enabled config.
3. Add extension voice runtime and popup controls while preserving playback-only behavior when voice is disabled.
4. Change effective voice-enabled room capacity to 4 and update admin/config docs.
5. Release with a documented LiveKit deployment checklist and rollback path: unset voice config or disable `VOICE_ENABLED` to return to playback-only behavior.

## Open Questions

- Which exact browser media host will be used for Chrome and Firefox after smoke testing: Chrome offscreen document only, a shared extension page, or target-specific implementations?
- What token TTL should be used for the first release? A short TTL such as 10-15 minutes is likely sufficient, but reconnect behavior should determine the final value.
- Should muted users stay connected to LiveKit as subscribers, or disconnect from LiveKit when they only want playback sync and no voice audio?
