export interface PopupRefs {
  serverStatus: HTMLElement;
  roomStatus: HTMLElement;
  membersStatus: HTMLElement;
  message: HTMLElement;
  roomPanelJoined: HTMLElement;
  roomPanelIdle: HTMLElement;
  roomCodeInput: HTMLInputElement;
  copyRoomButton: HTMLButtonElement;
  shareCurrentVideoButton: HTMLButtonElement;
  sharedVideoCard: HTMLButtonElement;
  sharedVideoTitle: HTMLElement;
  sharedVideoMeta: HTMLElement;
  sharedVideoOwner: HTMLElement;
  voiceStatus: HTMLElement;
  voiceDot: HTMLElement;
  voiceMicState: HTMLElement;
  voiceMicButton: HTMLButtonElement;
  voiceMicLabel: HTMLElement;
  voiceError: HTMLElement;
  logs: HTMLElement;
  memberList: HTMLElement;
  copyLogsButton: HTMLButtonElement;
  serverUrlInput: HTMLInputElement;
  saveServerUrlButton: HTMLButtonElement;
  debugMemberStatus: HTMLElement;
  retryStatusValue: HTMLElement;
  retryStatusCount: HTMLElement;
  clockStatus: HTMLElement;
  createRoomButton: HTMLButtonElement;
  joinRoomButton: HTMLButtonElement;
  leaveRoomButton: HTMLButtonElement;
}

export function collectPopupRefs(): PopupRefs {
  return {
    serverStatus: getById("server-status"),
    roomStatus: getById("room-status"),
    membersStatus: getById("members-status"),
    message: getById("status-message"),
    roomPanelJoined: getById("room-panel-joined"),
    roomPanelIdle: getById("room-panel-idle"),
    roomCodeInput: getById("room-code") as HTMLInputElement,
    copyRoomButton: getById("copy-room") as HTMLButtonElement,
    shareCurrentVideoButton: getById(
      "share-current-video",
    ) as HTMLButtonElement,
    sharedVideoCard: getById("shared-video-card") as HTMLButtonElement,
    sharedVideoTitle: getById("shared-video-title"),
    sharedVideoMeta: getById("shared-video-meta"),
    sharedVideoOwner: getById("shared-video-owner"),
    voiceStatus: getById("voice-status"),
    voiceDot: getById("voice-dot"),
    voiceMicState: getById("voice-mic-state"),
    voiceMicButton: getById("voice-mic-toggle") as HTMLButtonElement,
    voiceMicLabel: getById("voice-mic-label"),
    voiceError: getById("voice-error"),
    logs: getById("debug-logs"),
    memberList: getById("member-list"),
    copyLogsButton: getById("copy-logs") as HTMLButtonElement,
    serverUrlInput: getById("server-url") as HTMLInputElement,
    saveServerUrlButton: getById("save-server-url") as HTMLButtonElement,
    debugMemberStatus: getById("member-status"),
    retryStatusValue: getById("retry-status-value"),
    retryStatusCount: getById("retry-status-count"),
    clockStatus: getById("clock-status"),
    createRoomButton: getById("create-room") as HTMLButtonElement,
    joinRoomButton: getById("join-room") as HTMLButtonElement,
    leaveRoomButton: getById("leave-room") as HTMLButtonElement,
  };
}

function getById(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return node;
}
