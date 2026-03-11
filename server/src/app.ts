import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  isClientMessage,
  type ClientMessage,
  type PlaybackState,
  type RoomState,
  type ServerMessage,
  type SharedVideo
} from "@bili-syncplay/protocol";

type Session = {
  id: string;
  socket: WebSocket;
  roomCode: string | null;
  displayName: string;
};

type Room = {
  code: string;
  sharedVideo: SharedVideo | null;
  playback: PlaybackState | null;
  members: Map<string, Session>;
};

export const INVALID_JSON_MESSAGE = "Invalid JSON message.";
export const INVALID_CLIENT_MESSAGE_MESSAGE = "Invalid client message payload.";
export const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error.";

const PAUSE_DOMINANCE_WINDOW_MS = 400;

export type SyncServer = {
  httpServer: HttpServer;
  close: () => Promise<void>;
};

export function createSyncServer(): SyncServer {
  const rooms = new Map<string, Room>();

  const httpServer = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "bili-syncplay-server" }));
  });

  const wss = new WebSocketServer({ server: httpServer });

  function createRoomCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  }

  function roomStateOf(room: Room): RoomState {
    return {
      roomCode: room.code,
      sharedVideo: room.sharedVideo,
      playback: room.playback,
      members: Array.from(room.members.values()).map((member) => ({
        id: member.id,
        name: member.displayName
      }))
    };
  }

  function parseBilibiliVideoRef(url: string | undefined | null): { videoId: string; normalizedUrl: string } | null {
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url);
      const bvid = parsed.searchParams.get("bvid");
      if (bvid) {
        const cid = parsed.searchParams.get("cid");
        const p = parsed.searchParams.get("p");
        return {
          videoId: cid ? `${bvid}:${cid}` : p ? `${bvid}:p${p}` : bvid,
          normalizedUrl: cid
            ? `https://www.bilibili.com/video/${bvid}?cid=${cid}`
            : p
              ? `https://www.bilibili.com/video/${bvid}?p=${p}`
              : `https://www.bilibili.com/video/${bvid}`
        };
      }

      const pathname = parsed.pathname.replace(/\/+$/, "");
      const match = pathname.match(/^\/(?:video|bangumi\/play)\/([^/?]+)$/);
      if (!match) {
        if (pathname === "/list/watchlater" || pathname === "/medialist/play/watchlater") {
          return null;
        }
        return null;
      }

      const p = parsed.searchParams.get("p");
      return {
        videoId: p ? `${match[1]}:p${p}` : match[1],
        normalizedUrl: p ? `${parsed.origin}${pathname}?p=${p}` : `${parsed.origin}${pathname}`
      };
    } catch {
      return null;
    }
  }

  function normalizeUrl(url: string | undefined | null): string | null {
    return parseBilibiliVideoRef(url)?.normalizedUrl ?? null;
  }

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendError(socket: WebSocket, message: string): void {
    send(socket, {
      type: "error",
      payload: { message }
    });
  }

  function parseIncomingMessage(raw: RawData): unknown {
    return JSON.parse(raw.toString()) as unknown;
  }

  function broadcastRoomState(room: Room): void {
    const message: ServerMessage = {
      type: "room:state",
      payload: roomStateOf(room)
    };

    for (const member of room.members.values()) {
      send(member.socket, message);
    }
  }

  function getOrCreateRoom(code?: string): Room {
    const roomCode = code ?? createRoomCode();
    const existing = rooms.get(roomCode);
    if (existing) {
      return existing;
    }

    const room: Room = {
      code: roomCode,
      sharedVideo: null,
      playback: null,
      members: new Map()
    };
    rooms.set(roomCode, room);
    return room;
  }

  function leaveRoom(session: Session): void {
    if (!session.roomCode) {
      return;
    }

    const room = rooms.get(session.roomCode);
    if (!room) {
      session.roomCode = null;
      return;
    }

    room.members.delete(session.id);
    session.roomCode = null;

    if (room.members.size === 0) {
      rooms.delete(room.code);
      return;
    }

    broadcastRoomState(room);
  }

  function joinRoom(session: Session, roomCode: string): Room {
    leaveRoom(session);
    const room = getOrCreateRoom(roomCode);
    room.members.set(session.id, session);
    session.roomCode = room.code;
    return room;
  }

  function shouldIgnorePlaybackUpdate(room: Room, nextPlayback: PlaybackState, now: number): boolean {
    if (!room.playback) {
      return false;
    }

    const currentPlayback = room.playback;
    if (currentPlayback.actorId === nextPlayback.actorId) {
      return false;
    }
    const currentIsStopLike = currentPlayback.playState === "paused" || currentPlayback.playState === "buffering";
    const nextIsPlaying = nextPlayback.playState === "playing";
    const withinPauseWindow = now - currentPlayback.serverTime < PAUSE_DOMINANCE_WINDOW_MS;
    const closeInTimeline = Math.abs(nextPlayback.currentTime - currentPlayback.currentTime) < 1.2;

    if (currentIsStopLike && nextIsPlaying && withinPauseWindow && closeInTimeline) {
      return true;
    }

    return false;
  }

  function handleClientMessage(session: Session, message: ClientMessage): void {
    switch (message.type) {
      case "room:create": {
        session.displayName = message.payload?.displayName?.trim() || session.displayName;
        let room = getOrCreateRoom();
        while (rooms.has(room.code) && room.members.size > 0) {
          room = getOrCreateRoom();
        }
        const joinedRoom = joinRoom(session, room.code);
        send(session.socket, {
          type: "room:created",
          payload: {
            roomCode: joinedRoom.code,
            memberId: session.id
          }
        });
        broadcastRoomState(joinedRoom);
        return;
      }
      case "room:join": {
        session.displayName = message.payload.displayName?.trim() || session.displayName;
        const room = rooms.get(message.payload.roomCode);
        if (!room) {
          send(session.socket, {
            type: "error",
            payload: { message: "Room not found." }
          });
          return;
        }
        const joinedRoom = joinRoom(session, room.code);
        send(session.socket, {
          type: "room:joined",
          payload: {
            roomCode: joinedRoom.code,
            memberId: session.id
          }
        });
        broadcastRoomState(joinedRoom);
        return;
      }
      case "room:leave": {
        leaveRoom(session);
        return;
      }
      case "video:share": {
        if (!session.roomCode) {
          return;
        }
        const room = rooms.get(session.roomCode);
        if (!room) {
          return;
        }
        room.sharedVideo = {
          ...message.payload,
          sharedByMemberId: session.id
        };
        room.playback = {
          url: message.payload.url,
          currentTime: 0,
          playState: "paused",
          playbackRate: 1,
          updatedAt: Date.now(),
          serverTime: Date.now(),
          actorId: session.id,
          seq: 0
        };
        broadcastRoomState(room);
        return;
      }
      case "playback:update": {
        if (!session.roomCode) {
          return;
        }
        const room = rooms.get(session.roomCode);
        if (!room) {
          return;
        }
        if (!room.sharedVideo) {
          return;
        }
        const sharedUrl = normalizeUrl(room.sharedVideo.url);
        const playbackUrl = normalizeUrl(message.payload.url);
        if (!sharedUrl || !playbackUrl || sharedUrl !== playbackUrl) {
          return;
        }
        const now = Date.now();
        if (shouldIgnorePlaybackUpdate(room, message.payload, now)) {
          return;
        }
        room.playback = {
          ...message.payload,
          serverTime: now
        };
        broadcastRoomState(room);
        return;
      }
      case "sync:request": {
        if (!session.roomCode) {
          return;
        }
        const room = rooms.get(session.roomCode);
        if (!room) {
          return;
        }
        send(session.socket, {
          type: "room:state",
          payload: roomStateOf(room)
        });
        return;
      }
      case "sync:ping": {
        const serverReceiveTime = Date.now();
        send(session.socket, {
          type: "sync:pong",
          payload: {
            clientSendTime: message.payload.clientSendTime,
            serverReceiveTime,
            serverSendTime: Date.now()
          }
        });
        return;
      }
      default: {
        const exhaustiveCheck: never = message;
        return exhaustiveCheck;
      }
    }
  }

  wss.on("connection", (socket) => {
    const session: Session = {
      id: randomUUID(),
      socket,
      roomCode: null,
      displayName: `Guest-${Math.floor(Math.random() * 900 + 100)}`
    };
    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = parseIncomingMessage(raw);
      } catch {
        sendError(socket, INVALID_JSON_MESSAGE);
        return;
      }

      if (!isClientMessage(parsed)) {
        sendError(socket, INVALID_CLIENT_MESSAGE_MESSAGE);
        return;
      }

      try {
        handleClientMessage(session, parsed);
      } catch (error) {
        console.error("Unhandled client message error", error);
        sendError(socket, INTERNAL_SERVER_ERROR_MESSAGE);
      }
    });

    socket.on("close", () => {
      leaveRoom(session);
    });
  });

  return {
    httpServer,
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close((wsError) => {
          if (wsError) {
            reject(wsError);
            return;
          }
          httpServer.close((httpError) => {
            if (httpError) {
              reject(httpError);
              return;
            }
            resolve();
          });
        });
      })
  };
}
