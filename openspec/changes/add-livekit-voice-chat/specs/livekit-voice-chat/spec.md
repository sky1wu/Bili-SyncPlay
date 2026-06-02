## ADDED Requirements

### Requirement: Voice-enabled rooms use LiveKit SFU

The system SHALL provide room-scoped voice chat through an operator-managed LiveKit SFU when voice configuration is enabled.

#### Scenario: Voice service available for a joined room

- **WHEN** a member is connected to a Bili-SyncPlay room and the server has valid LiveKit configuration
- **THEN** the extension can obtain LiveKit connection details for that room

#### Scenario: Voice service disabled

- **WHEN** LiveKit configuration is absent or voice is disabled
- **THEN** playback sync continues to work and the extension reports voice as unavailable

### Requirement: Server issues scoped LiveKit access

The server SHALL issue LiveKit access only after validating that the requester is an active member of the target Bili-SyncPlay room.

#### Scenario: Valid member requests voice access

- **WHEN** a connected member sends a voice access request with a valid member token
- **THEN** the server returns a LiveKit URL, a short-lived token, the mapped LiveKit room name, and the participant identity

#### Scenario: Non-member requests voice access

- **WHEN** a client sends a voice access request without a valid room membership or member token
- **THEN** the server rejects the request without issuing a LiveKit token

#### Scenario: Browser never receives LiveKit secrets

- **WHEN** the server responds to any voice access request
- **THEN** the response contains no LiveKit API key, API secret, or signing material

### Requirement: Voice participant identity maps to room member identity

The system SHALL map each LiveKit participant to the existing Bili-SyncPlay member identity for the same room.

#### Scenario: Token identity is generated

- **WHEN** the server creates a LiveKit token for a room member
- **THEN** the LiveKit room name is derived from the Bili-SyncPlay room code and the participant identity is the member id

#### Scenario: Display names update

- **WHEN** a room member's display name changes before a new voice token is issued
- **THEN** the new token uses the latest display name available to the server

### Requirement: Voice-enabled rooms are limited to four members

The system SHALL enforce a maximum of four room members when voice chat is enabled.

#### Scenario: Fifth member attempts to join

- **WHEN** four members are already in a voice-enabled room and another user attempts to join
- **THEN** the server rejects the join with a room-full error and no LiveKit access can be issued

#### Scenario: Concurrent joins hit capacity

- **WHEN** multiple users join a voice-enabled room concurrently near the four-member limit
- **THEN** the server admits no more than four members

### Requirement: Room members can hear voice by default

The extension SHALL make room voice audio available to joined members by default when voice service is available.

#### Scenario: Member joins a room with voice enabled

- **WHEN** a member joins a room and voice service is available
- **THEN** the extension connects or prepares connection to the room voice session for receiving remote audio

#### Scenario: Remote member speaks

- **WHEN** a remote room member publishes audio through LiveKit
- **THEN** the local extension plays that audio or reports that browser interaction is required to start audio playback

### Requirement: Microphone is muted by default

The extension SHALL keep the local microphone muted until the user explicitly turns it on.

#### Scenario: User joins a room

- **WHEN** the extension enters a room with voice enabled
- **THEN** it does not request microphone permission and does not publish local microphone audio

#### Scenario: User turns microphone on

- **WHEN** the user activates the microphone control
- **THEN** the extension requests microphone permission if needed and publishes local audio only after permission succeeds

#### Scenario: User turns microphone off

- **WHEN** the user deactivates the microphone control
- **THEN** the extension stops publishing local microphone audio and reflects the muted state in the popup

### Requirement: Voice state is visible in the popup

The popup SHALL show voice availability, connection state, local microphone state, and participant voice state in the room UI.

#### Scenario: Voice is connected

- **WHEN** the local member is connected to the room voice session
- **THEN** the popup shows voice connected status and the local microphone state

#### Scenario: Participant mute state changes

- **WHEN** a room participant mutes or unmutes their microphone
- **THEN** the popup updates that participant's voice indicator

#### Scenario: Voice fails

- **WHEN** token issuance, LiveKit connection, microphone permission, or audio playback fails
- **THEN** the popup shows a localized error without disconnecting playback sync

### Requirement: Voice lifecycle follows room lifecycle

The extension SHALL align LiveKit voice connection lifecycle with Bili-SyncPlay room lifecycle.

#### Scenario: User leaves room

- **WHEN** the user leaves the Bili-SyncPlay room
- **THEN** the extension disconnects from the LiveKit room and clears local voice state

#### Scenario: Socket reconnects to same room

- **WHEN** the extension reconnects to the Bili-SyncPlay server and restores the same room
- **THEN** the extension refreshes voice access and reconnects to the LiveKit room if voice was available

#### Scenario: Room changes

- **WHEN** the user leaves one room and joins another
- **THEN** the extension disconnects from the old LiveKit room before connecting to the new room voice session

### Requirement: Voice secrets remain server-side

The system SHALL keep LiveKit API key and API secret in server-side configuration only.

#### Scenario: Configuration is loaded

- **WHEN** the server starts with LiveKit voice enabled
- **THEN** it reads LiveKit URL, API key, API secret, and voice capacity through the server config layer

#### Scenario: Secret is missing

- **WHEN** voice is enabled but required LiveKit secret configuration is missing
- **THEN** the server fails voice access requests with a voice-unavailable error and does not expose partial secret state

### Requirement: Playback-only behavior remains available

The system SHALL preserve existing synchronized playback behavior when voice chat is unavailable, disabled, or failing.

#### Scenario: LiveKit is down

- **WHEN** LiveKit is unreachable but the Bili-SyncPlay server is reachable
- **THEN** room creation, room joining, video sharing, and playback sync continue to function

#### Scenario: Microphone permission denied

- **WHEN** the user denies microphone permission
- **THEN** the extension keeps the user muted, reports the permission failure, and keeps playback sync active
