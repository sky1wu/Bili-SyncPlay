import type { ErrorCode } from "@bili-syncplay/protocol";

type MessageParams = Record<string, string | number | null | undefined>;

type MessageCatalog = Record<string, string>;

const MESSAGES: Record<"zh" | "en", MessageCatalog> = {
  zh: {
    popupTitle: "Bili SyncPlay",
    metricConnectionStatus: "连接状态",
    metricRoomMembers: "房间人数",
    metricCurrentRoomCode: "当前房间码",
    sectionRoom: "房间",
    actionCopy: "复制",
    actionLeave: "退出",
    actionCreate: "创建",
    roomCodePlaceholder: "输入房间码",
    actionJoin: "加入",
    sectionSharedVideo: "当前共享视频",
    stateNoSharedVideo: "暂无共享视频",
    actionOpenSharedVideoHint: "点击可打开共享视频",
    actionOpenSharedVideo: "打开共享视频",
    ownerSharedBy: "由 {owner} 共享",
    actionShareCurrentVideo: "同步当前页视频",
    sectionRoomMembers: "成员",
    sectionAdvancedInfo: "高级设置",
    metricServerUrl: "服务器地址",
    actionSave: "保存",
    metricCurrentIdentity: "当前身份",
    metricReconnectCountdown: "重连倒计时",
    metricClockSync: "时钟校准",
    metricClockOffset: "偏移",
    metricClockRtt: "RTT",
    metricClockHelp: "偏移表示本地时间与房间时间差，RTT 表示网络往返延迟。",
    sectionDebugLogs: "调试日志",
    stateNoLogs: "暂无日志",
    statusConnected: "已连接",
    statusDisconnected: "未连接",
    membersOnline: "{count} 人在线",
    membersCount: "{count}人",
    retrySeconds: "{seconds} 秒",
    clockStatus: "偏移 {offset}ms / RTT {rtt}ms",
    stateNoMembers: "暂无成员",
    memberSelf: "我 ({name})",
    confirmCreateRoomBeforeShare:
      "当前未加入房间。是否创建房间并同步当前页视频？",
    confirmReplaceSharedVideo:
      "当前房间正在同步《{currentTitle}》。\n是否替换为《{nextTitle}》？",
    errorInvalidInviteFormat: "邀请格式无效，请输入“房间码:加入码”。",
    invalidServerUrl: "服务端地址必须以 ws:// 或 wss:// 开头。",
    serverUrlAdjusted: "服务端地址已调整为 {resolved}，请核对。",
    connectionServerUnreachable: "无法连接到同步服务器。",
    connectionHandshakeRejected:
      "服务器可达，但 WebSocket 握手被拒绝。请检查服务端状态，以及反向代理是否已正确转发 WebSocket。",
    connectionOriginRejected:
      "服务器可达，但 WebSocket 握手被拒绝。请检查服务端 ALLOWED_ORIGINS 是否包含 {extensionOrigin}，以及反向代理是否已正确转发 WebSocket。",
    connectionAllowedOriginsRejected:
      "服务器可达，但 WebSocket 握手被拒绝。请检查服务端 ALLOWED_ORIGINS，以及反向代理是否已正确转发 WebSocket。",
    adminRemovedFromRoom: "你已被管理员移出房间。",
    adminDisconnectedSession: "你的连接已被管理员断开。",
    adminClosedRoom: "当前房间已被管理员关闭。",
    leftRoomWithReason: "已退出房间：{reason}",
    popupErrorNoActiveTab: "当前没有活动标签页。",
    popupErrorOpenBilibiliVideo: "请先打开一个哔哩哔哩视频页面。",
    popupErrorNoPlayableVideo: "当前页面没有可播放的视频。",
    popupErrorCannotAccessPage: "无法访问当前页面。",
    popupErrorMemberTokenMissing: "成员令牌缺失，请重新加入房间。",
    popupErrorReconnectFailed: "重试 {attempts} 次后仍无法连接到同步服务器。",
    popupErrorCannotReadCurrentVideo: "无法读取当前视频。",
    serverErrorRoomNotFound: "房间不存在。",
    serverErrorJoinTokenInvalid: "加入码无效，请检查后重试。",
    serverErrorMemberTokenInvalid: "成员令牌无效，请重新加入房间。",
    serverErrorNotInRoom: "请先加入房间。",
    serverErrorRateLimited: "请求过于频繁，请稍后再试。",
    serverErrorRoomFull: "房间已满。",
    serverErrorInvalidMessage: "当前请求无效。",
    serverErrorInternal: "服务器内部错误。",
    toastMemberJoined: "{name} 加入了房间",
    toastMemberLeft: "{name} 离开了房间",
    toastStartedPlaying: "{name} 开始播放",
    toastPausedVideo: "{name} 暂停了视频",
    toastSwitchedRate: "{name} 切换到 {rate}",
    toastSeekedTo: "{name} 跳转到 {time}",
    toastSharedNewVideo: "{name} 共享了新视频：{title}",
  },
  en: {
    popupTitle: "Bili SyncPlay",
    metricConnectionStatus: "Connection",
    metricRoomMembers: "Members",
    metricCurrentRoomCode: "Room code",
    sectionRoom: "Room",
    actionCopy: "Copy",
    actionLeave: "Leave",
    actionCreate: "Create",
    roomCodePlaceholder: "Enter invite code",
    actionJoin: "Join",
    sectionSharedVideo: "Current shared video",
    stateNoSharedVideo: "No shared video yet",
    actionOpenSharedVideoHint: "Click to open the shared video",
    actionOpenSharedVideo: "Open shared video",
    ownerSharedBy: "Shared by {owner}",
    actionShareCurrentVideo: "Sync current page video",
    sectionRoomMembers: "Room members",
    sectionAdvancedInfo: "Advanced info",
    metricServerUrl: "Server URL",
    actionSave: "Save",
    metricCurrentIdentity: "Identity",
    metricReconnectCountdown: "Reconnect in",
    metricClockSync: "Clock sync",
    metricClockOffset: "Offset",
    metricClockRtt: "RTT",
    metricClockHelp:
      "Offset is the local time delta from the room clock, and RTT is the round-trip network latency.",
    sectionDebugLogs: "Debug logs",
    stateNoLogs: "No logs yet",
    statusConnected: "Connected",
    statusDisconnected: "Disconnected",
    membersOnline: "{count} online",
    membersCount: "{count} members",
    retrySeconds: "{seconds}s",
    clockStatus: "Offset {offset}ms / RTT {rtt}ms",
    stateNoMembers: "No members yet",
    memberSelf: "Me ({name})",
    confirmCreateRoomBeforeShare:
      "You're not in a room yet. Create one and sync the current page video?",
    confirmReplaceSharedVideo:
      'The room is currently syncing "{currentTitle}".\nReplace it with "{nextTitle}"?',
    errorInvalidInviteFormat:
      'Invalid invite format. Enter "ROOMCODE:JOINTOKEN".',
    invalidServerUrl: "Server URL must start with ws:// or wss://.",
    serverUrlAdjusted: "Server URL was adjusted to {resolved}; please verify.",
    connectionServerUnreachable: "Unable to connect to the sync server.",
    connectionHandshakeRejected:
      "The server is reachable, but the WebSocket handshake was rejected. Check the server status and make sure the reverse proxy forwards WebSocket correctly.",
    connectionOriginRejected:
      "The server is reachable, but the WebSocket handshake was rejected. Check whether ALLOWED_ORIGINS includes {extensionOrigin}, and make sure the reverse proxy forwards WebSocket correctly.",
    connectionAllowedOriginsRejected:
      "The server is reachable, but the WebSocket handshake was rejected. Check ALLOWED_ORIGINS and make sure the reverse proxy forwards WebSocket correctly.",
    adminRemovedFromRoom: "You were removed from the room by an admin.",
    adminDisconnectedSession: "Your connection was terminated by an admin.",
    adminClosedRoom: "This room was closed by an admin.",
    leftRoomWithReason: "You left the room: {reason}",
    popupErrorNoActiveTab: "No active tab.",
    popupErrorOpenBilibiliVideo: "Open a Bilibili video page first.",
    popupErrorNoPlayableVideo:
      "No playable video was found on the current page.",
    popupErrorCannotAccessPage: "Cannot access the current page.",
    popupErrorMemberTokenMissing: "Member token is missing. Rejoin the room.",
    popupErrorReconnectFailed:
      "Still unable to connect to the sync server after {attempts} attempts.",
    popupErrorCannotReadCurrentVideo: "Unable to read the current video.",
    serverErrorRoomNotFound: "The room was not found.",
    serverErrorJoinTokenInvalid: "The join token is invalid.",
    serverErrorMemberTokenInvalid:
      "The member token is invalid. Rejoin the room.",
    serverErrorNotInRoom: "Join a room first.",
    serverErrorRateLimited: "Too many requests. Try again later.",
    serverErrorRoomFull: "Room is full.",
    serverErrorInvalidMessage: "The request was rejected as invalid.",
    serverErrorInternal: "Internal server error.",
    toastMemberJoined: "{name} joined the room",
    toastMemberLeft: "{name} left the room",
    toastStartedPlaying: "{name} started playback",
    toastPausedVideo: "{name} paused the video",
    toastSwitchedRate: "{name} switched to {rate}",
    toastSeekedTo: "{name} jumped to {time}",
    toastSharedNewVideo: "{name} shared a new video: {title}",
  },
};

let localeOverride: string | null = null;

function resolveLocale(): "zh" | "en" {
  const locale = localeOverride ?? getUiLanguage();
  return /^en\b/i.test(locale) ? "en" : "zh";
}

function getCatalog(): MessageCatalog {
  return MESSAGES[resolveLocale()];
}

function interpolate(template: string, params: MessageParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) =>
    String(params[key] ?? ""),
  );
}

export function getUiLanguage(): string {
  const chromeLocale =
    typeof chrome !== "undefined" ? chrome.i18n?.getUILanguage?.() : undefined;
  if (typeof chromeLocale === "string" && chromeLocale.trim()) {
    return chromeLocale;
  }

  const navigatorLocale = globalThis.navigator?.language;
  if (typeof navigatorLocale === "string" && navigatorLocale.trim()) {
    return navigatorLocale;
  }

  return "zh-CN";
}

export function getDocumentLanguage(): string {
  return resolveLocale() === "en" ? "en" : "zh-CN";
}

export function t(
  key: keyof typeof MESSAGES.zh,
  params?: MessageParams,
): string {
  return interpolate(getCatalog()[key], params);
}

export function localizeServerError(
  code: ErrorCode,
  fallbackMessage: string,
): string {
  if (resolveLocale() !== "en") {
    return fallbackMessage;
  }

  switch (code) {
    case "room_not_found":
      return t("serverErrorRoomNotFound");
    case "join_token_invalid":
      return t("serverErrorJoinTokenInvalid");
    case "member_token_invalid":
      return t("serverErrorMemberTokenInvalid");
    case "not_in_room":
      return t("serverErrorNotInRoom");
    case "rate_limited":
      return t("serverErrorRateLimited");
    case "room_full":
      return t("serverErrorRoomFull");
    case "invalid_message":
      return t("serverErrorInvalidMessage");
    case "internal_error":
      return t("serverErrorInternal");
    default:
      return fallbackMessage;
  }
}

export function setLocaleForTests(locale: string | null): void {
  localeOverride = locale;
}
