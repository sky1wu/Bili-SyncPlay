# Bili SyncPlay Privacy Policy

Effective date: 2026-04-13

This Privacy Policy applies to the Bili SyncPlay browser extension (the "Extension"). It explains what information the Extension processes, how that information is used, and what controls users have over related data when using the synchronized playback features.

## 1. Types of Information Processed

The Extension only processes information required to provide its core functionality. This mainly includes the following categories:

### 1.1 Personal Information

The Extension may read the display name or username visible on Bilibili pages and use it as the member display name in a sync room so participants can identify who started playback, paused, switched videos, or changed playback speed.

The Extension does not intentionally collect real names, government ID numbers, email addresses, phone numbers, or mailing addresses.

### 1.2 Web History

The Extension reads the URL of the current Bilibili video page in order to:

- determine whether the current page supports synchronized playback
- identify the currently shared video
- synchronize the currently shared video across room participants

### 1.3 User Activity

The Extension processes player states and user actions that are directly related to synchronized playback, including:

- play or pause state
- current playback position
- playback speed
- page interaction results related to sync control

This information is used only to provide synchronized playback and is not used for advertising, profiling, or cross-site tracking.

### 1.4 Website Content

The Extension may read limited content from the current video page, such as:

- video title
- video identifiers such as `bvid` and `cid`
- video information associated with the current page

This content is used only to identify and synchronize the current video.

## 2. How Information Is Used

The Extension uses the information above only for the following purposes:

- identifying the current Bilibili video page and its associated video
- creating, joining, and maintaining synchronized playback rooms
- synchronizing play, pause, playback position, and playback speed between room participants
- displaying room state, shared video information, and member display names in the Extension UI
- maintaining connection state, diagnosing connection issues, and improving feature reliability

The Extension does not use this information for:

- advertising
- selling data to third parties
- user profiling unrelated to the core function
- cross-site tracking

## 3. Remote Communication

To provide its features, the Extension may communicate with the following remote endpoints:

### 3.1 Bilibili APIs

The Extension may access Bilibili-related APIs to read necessary information such as the currently available display name for the logged-in user.

### 3.2 Sync Server

The Extension connects to a sync server configured or used by the user in order to exchange information required for synchronized playback between room participants, including:

- room state
- currently shared video information
- current playback state

If you configure a third-party sync server yourself, related data will be sent to that server, and data retention and access control will depend on how that server is deployed and operated.

## 4. Local Storage

To provide a continuous user experience, the Extension may store the following information locally in the browser:

- room code
- tokens or session identifiers required to join a room
- member identifier
- display name
- latest room state
- server URL configuration

This information is mainly stored in the browser extension storage area to preserve session state and restore the Extension state.

## 5. Data Sharing and Disclosure

The Extension does not sell personal data.

The Extension only sends relevant information, to the extent necessary for synchronized playback, to:

- the sync server you connect to
- other participants in the same sync room

Shared information may include:

- display name
- currently shared video information
- current playback state such as play, pause, playback position, and playback speed

Unless required by law or regulation, the Extension does not actively disclose this information to unrelated third parties.

## 6. Remote Code

The Extension does not download, inject, or execute remote code.

All scripts executed by the Extension are packaged with the Extension and run locally. Communication with remote servers is used only for data transfer and synchronization, not for dynamically loading executable code.

## 7. Data Security

The Extension makes reasonable efforts to protect the security of the information it processes and to reduce the risk of unauthorized access, use, or disclosure. However, no method of network transmission or electronic storage can guarantee absolute security.

If you configure a third-party sync server yourself, the security of related data will also depend on that server's own configuration and operations.

## 8. User Controls

You may control related data in the following ways:

- stop using or uninstall the Extension
- leave the sync room
- clear locally stored Extension data in your browser
- modify or remove the configured sync server URL

## 9. Children's Privacy

The Extension is not specifically directed to children and does not knowingly collect sensitive personal information from children.

## 10. Policy Updates

This Privacy Policy may be updated based on feature changes, legal requirements, or operational needs. The latest version will be published in the project repository:

https://github.com/Sky1wu/Bili-SyncPlay

## 11. Contact

If you have any questions, comments, or requests regarding this Privacy Policy, you may contact the project through:

- Project: https://github.com/Sky1wu/Bili-SyncPlay
- Issues: https://github.com/Sky1wu/Bili-SyncPlay/issues
