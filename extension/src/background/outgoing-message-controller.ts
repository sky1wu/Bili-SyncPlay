import type {
  ClientMessage,
  PlaybackState,
  RoomState,
} from "@bili-syncplay/protocol";

const HEARTBEAT_LOG_INTERVAL_MS = 10000;

type PlaybackLogState = {
  key: string | null;
  at: number;
};

type PendingOutgoingPlaybackUpdate = {
  actorId: string;
  seq: number;
  url: string;
  currentTime: number;
  playbackRate: number;
  playState: string;
  syncIntent: string | null;
  sentAt: number;
};

export interface OutgoingMessageController {
  sendToServer(message: ClientMessage): void;
  consumeRoomState(roomState: RoomState): void;
}

export function createOutgoingMessageController(args: {
  connectionState: {
    socket: WebSocket | null;
  };
  connect: () => Promise<void>;
  log: (message: string) => void;
  shouldLogOutgoingMessage: (messageType: ClientMessage["type"]) => boolean;
  normalizeUrl: (url: string | null | undefined) => string | null;
  now?: () => number;
}): OutgoingMessageController {
  const nowOf = args.now ?? Date.now;
  let pendingOutgoingPlaybackUpdate: PendingOutgoingPlaybackUpdate | null =
    null;
  const playbackUpdateLogState = {
    outgoing: { key: null as string | null, at: 0 },
    confirm: { key: null as string | null, at: 0 },
    pending: { key: null as string | null, at: 0 },
    roomState: { key: null as string | null, at: 0 },
  };

  function shouldLogPlaybackHeartbeat(
    state: PlaybackLogState,
    key: string,
    now = nowOf(),
  ): boolean {
    if (state.key === key && now - state.at < HEARTBEAT_LOG_INTERVAL_MS) {
      return false;
    }
    state.key = key;
    state.at = now;
    return true;
  }

  function rememberPendingPlayback(playback: PlaybackState): void {
    pendingOutgoingPlaybackUpdate = {
      actorId: playback.actorId,
      seq: playback.seq,
      url: playback.url,
      currentTime: playback.currentTime,
      playbackRate: playback.playbackRate,
      playState: playback.playState,
      syncIntent: playback.syncIntent ?? null,
      sentAt: nowOf(),
    };
  }

  function logOutgoingPlayback(playback: PlaybackState): void {
    const isHeartbeatPlaybackUpdate =
      playback.syncIntent === undefined && playback.playState === "playing";
    if (
      !isHeartbeatPlaybackUpdate ||
      shouldLogPlaybackHeartbeat(
        playbackUpdateLogState.outgoing,
        `${playback.playState}|${args.normalizeUrl(playback.url) ?? playback.url}|outgoing`,
      )
    ) {
      args.log(
        `-> playback:update actor=${playback.actorId} seq=${playback.seq} playState=${playback.playState} url=${playback.url} t=${playback.currentTime.toFixed(2)} rate=${playback.playbackRate.toFixed(2)} intent=${playback.syncIntent ?? "none"}`,
      );
    }
  }

  function logIncomingRoomState(roomState: RoomState): void {
    const isHeartbeatRoomState =
      roomState.playback?.playState === "playing" &&
      roomState.playback?.syncIntent === undefined;
    if (
      !isHeartbeatRoomState ||
      shouldLogPlaybackHeartbeat(
        playbackUpdateLogState.roomState,
        `${roomState.roomCode}|${args.normalizeUrl(roomState.sharedVideo?.url) ?? roomState.sharedVideo?.url ?? "none"}|${roomState.playback?.playState ?? "none"}|${roomState.playback?.actorId ?? "none"}|room-state`,
      )
    ) {
      args.log(
        `<- room:state room=${roomState.roomCode} shared=${roomState.sharedVideo?.url ?? "none"} actor=${roomState.playback?.actorId ?? "none"} seq=${roomState.playback?.seq ?? "none"} playState=${roomState.playback?.playState ?? "none"} t=${roomState.playback ? roomState.playback.currentTime.toFixed(2) : "n/a"} rate=${roomState.playback ? roomState.playback.playbackRate.toFixed(2) : "n/a"} intent=${roomState.playback?.syncIntent ?? "none"}`,
      );
    }
  }

  function reconcilePendingPlaybackWithRoomState(roomState: RoomState): void {
    if (
      !pendingOutgoingPlaybackUpdate ||
      !roomState.playback ||
      args.normalizeUrl(roomState.playback.url) !==
        args.normalizeUrl(pendingOutgoingPlaybackUpdate.url)
    ) {
      return;
    }

    const ageMs = nowOf() - pendingOutgoingPlaybackUpdate.sentAt;
    if (
      roomState.playback.actorId === pendingOutgoingPlaybackUpdate.actorId &&
      roomState.playback.seq >= pendingOutgoingPlaybackUpdate.seq
    ) {
      if (
        pendingOutgoingPlaybackUpdate.syncIntent !== null ||
        pendingOutgoingPlaybackUpdate.playState !== "playing" ||
        shouldLogPlaybackHeartbeat(
          playbackUpdateLogState.confirm,
          `${pendingOutgoingPlaybackUpdate.playState}|${args.normalizeUrl(pendingOutgoingPlaybackUpdate.url) ?? pendingOutgoingPlaybackUpdate.url}|confirm`,
        )
      ) {
        args.log(
          `Confirmed local playback:update actor=${pendingOutgoingPlaybackUpdate.actorId} pendingSeq=${pendingOutgoingPlaybackUpdate.seq} roomSeq=${roomState.playback.seq} playState=${roomState.playback.playState} t=${roomState.playback.currentTime.toFixed(2)} rate=${roomState.playback.playbackRate.toFixed(2)} intent=${roomState.playback.syncIntent ?? "none"} ageMs=${ageMs}`,
        );
      }
      pendingOutgoingPlaybackUpdate = null;
      return;
    }

    if (
      shouldLogPlaybackHeartbeat(
        playbackUpdateLogState.pending,
        `${pendingOutgoingPlaybackUpdate.playState}|${args.normalizeUrl(pendingOutgoingPlaybackUpdate.url) ?? pendingOutgoingPlaybackUpdate.url}|pending`,
      )
    ) {
      args.log(
        `Pending local playback:update actor=${pendingOutgoingPlaybackUpdate.actorId} pendingSeq=${pendingOutgoingPlaybackUpdate.seq} pendingState=${pendingOutgoingPlaybackUpdate.playState} pendingT=${pendingOutgoingPlaybackUpdate.currentTime.toFixed(2)} pendingRate=${pendingOutgoingPlaybackUpdate.playbackRate.toFixed(2)} pendingIntent=${pendingOutgoingPlaybackUpdate.syncIntent ?? "none"} sawActor=${roomState.playback.actorId} sawSeq=${roomState.playback.seq} sawState=${roomState.playback.playState} sawT=${roomState.playback.currentTime.toFixed(2)} sawRate=${roomState.playback.playbackRate.toFixed(2)} sawIntent=${roomState.playback.syncIntent ?? "none"} ageMs=${ageMs}`,
      );
    }
  }

  function sendToServer(message: ClientMessage): void {
    if (
      !args.connectionState.socket ||
      args.connectionState.socket.readyState !== WebSocket.OPEN
    ) {
      args.log(`Socket not ready for ${message.type}`);
      void args.connect();
      return;
    }

    if (message.type === "playback:update") {
      rememberPendingPlayback(message.payload.playback);
      logOutgoingPlayback(message.payload.playback);
    } else if (args.shouldLogOutgoingMessage(message.type)) {
      args.log(`-> ${message.type}`);
    }

    args.connectionState.socket.send(JSON.stringify(message));
  }

  function consumeRoomState(roomState: RoomState): void {
    logIncomingRoomState(roomState);
    reconcilePendingPlaybackWithRoomState(roomState);
  }

  return {
    sendToServer,
    consumeRoomState,
  };
}
