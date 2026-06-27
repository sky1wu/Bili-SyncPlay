import type {
  ClientMessage,
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import { isSocketWritable } from "./socket-manager";

export function createPendingShareToast(args: {
  state: RoomState;
  normalizedSharedUrl: string | null;
  now: number;
  ttlMs: number;
}): (SharedVideoToastPayload & { expiresAt: number; roomCode: string }) | null {
  if (!args.state.sharedVideo) {
    return null;
  }

  return {
    key: `${args.state.roomCode}:${args.normalizedSharedUrl ?? args.state.sharedVideo.url}:${args.now}`,
    actorId: args.state.playback?.actorId ?? null,
    title: args.state.sharedVideo.title,
    videoUrl: args.state.sharedVideo.url,
    roomCode: args.state.roomCode,
    expiresAt: args.now + args.ttlMs,
  };
}

export function getPendingShareToastFor(args: {
  pendingShareToast:
    | (SharedVideoToastPayload & { expiresAt: number; roomCode: string })
    | null;
  state: RoomState;
  normalizedPendingToastUrl: string | null;
  normalizedSharedUrl: string | null;
  now: number;
}): {
  pendingShareToast:
    | (SharedVideoToastPayload & { expiresAt: number; roomCode: string })
    | null;
  shareToast: SharedVideoToastPayload | null;
} {
  if (!args.pendingShareToast) {
    return {
      pendingShareToast: null,
      shareToast: null,
    };
  }

  if (
    args.pendingShareToast.expiresAt <= args.now ||
    args.pendingShareToast.roomCode !== args.state.roomCode
  ) {
    return {
      pendingShareToast: null,
      shareToast: null,
    };
  }

  if (args.normalizedPendingToastUrl !== args.normalizedSharedUrl) {
    return {
      pendingShareToast: args.pendingShareToast,
      shareToast: null,
    };
  }

  return {
    pendingShareToast: args.pendingShareToast,
    shareToast: {
      key: args.pendingShareToast.key,
      actorId: args.pendingShareToast.actorId,
      title: args.pendingShareToast.title,
      videoUrl: args.pendingShareToast.videoUrl,
    },
  };
}

export function flushPendingShare(args: {
  pendingSharedVideo: SharedVideo | null;
  pendingSharedPlayback: PlaybackState | null;
  connected: boolean;
  socketWritable: boolean;
  roomCode: string | null;
  memberToken: string | null;
}): {
  shouldFlush: boolean;
  video: SharedVideo | null;
  playback: PlaybackState | null;
} {
  if (
    !args.pendingSharedVideo ||
    !args.connected ||
    // `connected` lags the socket's close/error events, so a flush triggered by
    // `room:joined` can still see it true while the socket has already moved to
    // CLOSING/CLOSED. `sendToServer` silently drops a non-OPEN write, so gate on
    // the live `readyState`: when it is not writable, leave the share queued (and
    // its marker untouched) so the next reconnect's rejoin re-flushes it instead
    // of nulling `pendingSharedVideo` against a dropped send.
    !args.socketWritable ||
    !args.roomCode ||
    !args.memberToken
  ) {
    return {
      shouldFlush: false,
      video: null,
      playback: null,
    };
  }

  return {
    shouldFlush: true,
    video: args.pendingSharedVideo,
    playback: args.pendingSharedPlayback,
  };
}

export function executeFlushPendingShare(args: {
  roomSessionState: {
    pendingSharedVideo: SharedVideo | null;
    pendingSharedPlayback: PlaybackState | null;
    memberToken: string | null;
    roomCode: string | null;
  };
  connectionState: {
    connected: boolean;
    socketGeneration: number;
    socket: WebSocket | null;
  };
  shareState: {
    pendingLocalShareUrl: string | null;
    pendingLocalShareGeneration: number | null;
  };
  sendToServer: (message: ClientMessage) => void;
}): void {
  const plan = flushPendingShare({
    pendingSharedVideo: args.roomSessionState.pendingSharedVideo,
    pendingSharedPlayback: args.roomSessionState.pendingSharedPlayback,
    connected: args.connectionState.connected,
    socketWritable: isSocketWritable(args.connectionState.socket),
    roomCode: args.roomSessionState.roomCode,
    memberToken: args.roomSessionState.memberToken,
  });
  if (!plan.shouldFlush || !plan.video) {
    return;
  }
  // memberToken is guaranteed non-null when plan.shouldFlush is true
  args.sendToServer({
    type: "video:share",
    payload: {
      memberToken: args.roomSessionState.memberToken!,
      video: plan.video,
      ...(plan.playback ? { playback: plan.playback } : {}),
    },
  });
  args.roomSessionState.pendingSharedVideo = null;
  args.roomSessionState.pendingSharedPlayback = null;
  // The queued share was set while an earlier (now-superseded) socket was live,
  // so the pending-local-share confirmation marker is still tagged with that
  // socket's generation. This re-flush re-sends the share on the CURRENT live
  // socket, which is the one that will receive the confirming `room:state`, so
  // transfer marker ownership to it. Without this, the old socket's late close
  // (generation match) would clear a marker the live socket is still confirming,
  // while the live socket's own later supersede (nothing left queued) would fail
  // to clear it. Only re-stamp when a marker is actually pending.
  if (args.shareState.pendingLocalShareUrl !== null) {
    args.shareState.pendingLocalShareGeneration =
      args.connectionState.socketGeneration;
  }
}
