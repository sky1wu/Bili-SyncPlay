# Protocol Reference

[English](./protocol.md) | [简体中文](./protocol.zh-CN.md)

`@bili-syncplay/protocol` (`packages/protocol/`) is the single source of truth for the wire protocol between the extension and the server: message types, domain types, type guards, and Bilibili URL normalization. Always import through the package root; internal file layout is not part of the public surface. For the change process (versioning, compatibility windows, test checklist), see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Versioning

| Constant                   | Location                                | Value | Meaning                                                      |
| -------------------------- | --------------------------------------- | ----- | ------------------------------------------------------------ |
| `PROTOCOL_VERSION`         | `packages/protocol/src/types/common.ts` | `4`   | Version sent by the extension in `room:create` / `room:join` |
| `CURRENT_PROTOCOL_VERSION` | `server/src/messages.ts`                | `4`   | Version the server currently speaks                          |
| `MIN_PROTOCOL_VERSION`     | `server/src/messages.ts`                | `1`   | Oldest client version the server still accepts               |

Clients send `protocolVersion` inside the `room:create` / `room:join` payload; the server rejects clients below `MIN_PROTOCOL_VERSION` with the `unsupported_protocol_version` error code. Legacy clients that omit `protocolVersion` are treated according to the server's compatibility policy in `server/src/messages.ts`.

## Domain Types

### `SharedVideo`

| Field                 | Type      | Notes                                                                                                                                                                         |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `videoId`             | `string`  | Normalized video identity                                                                                                                                                     |
| `url`                 | `string`  | Share URL as sent by the sharer — accepted by the normalization helpers but not guaranteed pre-normalized (festival shares keep the raw page URL); normalize before comparing |
| `title`               | `string`  | Display title                                                                                                                                                                 |
| `sharedByMemberId`    | `string?` | Member who currently owns the share. In `room:state` this is resolved against the live member list, so it names the original sharer only while they are present — see below   |
| `sharedByDisplayName` | `string?` | Display name of that member; moves with `sharedByMemberId`                                                                                                                    |

A member id only exists while that member holds a seat, so the id stored at
`video:share` goes stale as soon as the sharer leaves or their `memberToken`
expires. Every `room:state` therefore resolves it: if the stored member is
online it is returned unchanged, otherwise the longest-tenured online member
inherits the share (ties broken by member id). The stored value is never
rewritten, so a sharer who merely dropped off gets the share back on reconnect.

Clients are told the answer and must not derive their own. A membership change
that moves ownership is always followed by a full `room:state`, because
`room:member-joined` / `room:member-left` only edit the recipient's member list
and leave its cached `sharedVideo` untouched.

### `PlaybackState`

| Field           | Type                                        | Notes                                                                                                                                                                                   |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`           | `string`                                    | URL the state applies to; like `SharedVideo.url`, normalize before comparing                                                                                                            |
| `currentTime`   | `number`                                    | Playback position in seconds                                                                                                                                                            |
| `playState`     | `"playing" \| "paused" \| "buffering"`      | `PlaybackPlayState`                                                                                                                                                                     |
| `syncIntent`    | `"explicit-seek" \| "explicit-ratechange"?` | Marks a state produced by an explicit seek / rate change (`PlaybackSyncIntent`)                                                                                                         |
| `userInitiated` | `boolean?`                                  | Hint that the transition came from an explicit user gesture rather than a buffer stall or remote-state application; receivers may skip flicker-defence debounces. Optional and additive |
| `naturalEnd`    | `boolean?`                                  | Hint that this paused state came from the shared video reaching its natural end; receivers apply it but suppress the misleading "paused" toast. Optional and additive                   |
| `playbackRate`  | `number`                                    | Playback rate                                                                                                                                                                           |
| `updatedAt`     | `number`                                    | Sender timestamp (ms)                                                                                                                                                                   |
| `serverTime`    | `number`                                    | Server timestamp stamped on relay (ms)                                                                                                                                                  |
| `actorId`       | `string`                                    | Member who produced the state                                                                                                                                                           |
| `seq`           | `number`                                    | Monotonic sequence number for ordering                                                                                                                                                  |

### `RoomState` and `RoomMember`

- `RoomMember`: `{ id: string; name: string }`
- `RoomState`: `{ roomCode: RoomCode; sharedVideo: SharedVideo | null; playback: PlaybackState | null; members: RoomMember[] }`

## Client Messages (`ClientMessage`)

| Type              | Payload                                                                 | Auth          | Purpose                                        |
| ----------------- | ----------------------------------------------------------------------- | ------------- | ---------------------------------------------- |
| `room:create`     | `{ displayName?, protocolVersion? }?`                                   | —             | Create a room                                  |
| `room:join`       | `{ roomCode, joinToken, memberToken?, displayName?, protocolVersion? }` | `joinToken`   | Join (or rejoin with a previous `memberToken`) |
| `profile:update`  | `{ memberToken, displayName }`                                          | `memberToken` | Change display name                            |
| `room:leave`      | `{ memberToken? }?`                                                     | `memberToken` | Leave the current room                         |
| `video:share`     | `{ memberToken, video: SharedVideo, playback?: PlaybackState }`         | `memberToken` | Share / replace the room's shared video        |
| `playback:update` | `{ memberToken, playback: PlaybackState }`                              | `memberToken` | Broadcast a playback state change              |
| `sync:request`    | `{ memberToken }`                                                       | `memberToken` | Request the current room state                 |
| `sync:ping`       | `{ clientSendTime }`                                                    | —             | Clock-offset probe                             |

## Server Messages (`ServerMessage`)

| Type                 | Payload                                                                  | Purpose                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `room:created`       | `{ roomCode, memberId, joinToken, memberToken, serverProtocolVersion? }` | Room created; carries the invite and session tokens                                                                                     |
| `room:joined`        | `{ roomCode, memberId, memberToken, serverProtocolVersion? }`            | Join succeeded; returns the session `memberToken` (a rejoin with a still-valid previous token reuses it, otherwise a new one is issued) |
| `room:state`         | `RoomState & { playbackAgeMs? }`                                         | Full room snapshot (after join, on request, on shared-video / playback changes)                                                         |
| `room:member-joined` | `{ roomCode, member: RoomMember }`                                       | Member joined (delta, sent to `protocolVersion >= 2` clients)                                                                           |
| `room:member-left`   | `{ roomCode, member: RoomMember }`                                       | Member left (delta, sent to `protocolVersion >= 2` clients)                                                                             |
| `error`              | `{ code: ErrorCode, message }`                                           | Request failed                                                                                                                          |
| `sync:pong`          | `{ clientSendTime, serverReceiveTime, serverSendTime }`                  | Clock-offset probe response                                                                                                             |

### Membership deltas

Membership changes are version-gated (`MEMBER_DELTA_PROTOCOL_VERSION = 2` in `server/src/room-event-consumer.ts`): clients with `protocolVersion >= 2` receive `room:member-joined` / `room:member-left` deltas and must apply them to their member list — `room:state` is not re-broadcast for membership changes. Legacy clients (v1 or no version) receive a full `room:state` instead.

### Playback snapshot age

`room:state` carries an optional `playbackAgeMs` alongside the room state: how long ago the server stamped `playback.serverTime`, computed from the server's own two timestamps at the moment of sending. It lets a client joining a room mid-playback start from where the room actually is instead of from the last broadcast's position, which can be up to one broadcast interval (~2.1s) old.

Two rules keep it sound, neither of which the type system enforces:

- **Computed at every send, never stored.** An age is only true at the instant it is sent; a stored one is a timestamp in disguise. That is why it lives on the `room:state` payload (`RoomStatePayload`) rather than inside `PlaybackState`, which the server persists and clients send back in `playback:update`.
- **A duration, never a timestamp.** A duration is safe across two disagreeing clocks — the receiver only adds it to an anchor of its own. A timestamp would force the receiver to subtract a server time from a local one, which measures the clock disagreement rather than elapsed time (see the playback timing invariants in [AGENTS.md](../../AGENTS.md)).

Receivers subtract it from the message's local arrival time to get the anchor the position is extrapolated from (`extension/src/background/clock-sync.ts`), ignoring values that are absent (legacy server), negative, or implausibly large. Absent means "assume current", the pre-#212 behaviour.

### Clock synchronization

`sync:ping` / `sync:pong` implement an NTP-style exchange: the client compares `clientSendTime`, `serverReceiveTime`, `serverSendTime`, and its own receive time to estimate the clock offset, which the extension's `clock-controller.ts` maintains. As of #210 that offset is a diagnostic shown in the popup, not an input to playback: positions are extrapolated from a local monotonic anchor instead, and `PlaybackState.serverTime` is used only as the server's version tag for a snapshot.

## Error Codes (`ErrorCode`)

`origin_not_allowed`, `room_not_found`, `join_token_invalid`, `member_token_invalid`, `not_in_room`, `rate_limited`, `invalid_message`, `payload_too_large`, `room_full`, `unsupported_protocol_version`, `internal_error`

The developer-facing symptoms for the common codes are listed in the [troubleshooting section](../development.md#troubleshooting).

## URL Normalization

`parseBilibiliVideoRef(url)` parses a supported Bilibili page URL into `{ videoId, normalizedUrl }`; `normalizeBilibiliUrl(url)` returns just the normalized URL (or `null`). Only `www.bilibili.com` is accepted, with these path shapes:

- `/video/<id>` (multi-part via `?p=`)
- `/bangumi/play/<id>`
- `/festival/<id>` (identity from `bvid` + `cid` query parameters)
- `/list/watchlater` and `/medialist/play/watchlater` (require `bvid` in the query)

All video-identity comparisons in the extension and server must go through these helpers instead of ad-hoc URL string handling.

## Type Guards

Runtime guards are exported from the package root. For wire validation, use the top-level guards:

- `isClientMessage(value)` — the server validates inbound client frames with this
- `isServerMessage(value)` — the extension validates server frames with this; `isRoomState(value)` covers a bare room snapshot

The other exported guards (`isSharedVideo`, `isPlaybackState`, `isClientHelloPayload`, `isRoomMember`, `isErrorMessage`, and primitives such as `isRoomCode`, `isToken`, `isVideoId`, `isBilibiliUrl`, `isPlaybackPlayState`) exist to compose and test the message guards. Note that the exported `isSharedVideo` and `isPlaybackState` come from the client-message guard set and enforce client-payload limits — for example, `isSharedVideo` caps `sharedByMemberId` at 32 characters, while server-issued member ids are 36-character UUIDs — so a server-populated `room:state.sharedVideo` can legitimately fail them. Do not validate server frames with client-payload guards; `isServerMessage` / `isRoomState` internally apply the more lenient server-side shapes.

When adding or changing a message, update the corresponding guard and its accepted/rejected payload tests in the same change (see the checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md)).
