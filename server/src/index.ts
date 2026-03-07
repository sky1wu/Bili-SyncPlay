import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
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

const rooms = new Map<string, Room>();
const sessions = new Map<WebSocket, Session>();
const port = Number(process.env.PORT ?? 8787);
const PAUSE_DOMINANCE_WINDOW_MS = 1500;

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
    members: Array.from(room.members.values()).map((member) => member.displayName)
  };
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
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
      room.sharedVideo = message.payload;
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
      if (!room.sharedVideo || room.sharedVideo.url !== message.payload.url) {
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

  sessions.set(socket, session);

  socket.on("message", (raw) => {
    try {
      const parsed = JSON.parse(raw.toString()) as unknown;
      if (!isClientMessage(parsed)) {
        send(socket, {
          type: "error",
          payload: { message: "Invalid message." }
        });
        return;
      }
      handleClientMessage(session, parsed);
    } catch (error) {
      send(socket, {
        type: "error",
        payload: { message: error instanceof Error ? error.message : "Unknown error." }
      });
    }
  });

  socket.on("close", () => {
    leaveRoom(session);
    sessions.delete(socket);
  });
});

httpServer.listen(port, () => {
  console.log(`Bili-SyncPlay server listening on http://localhost:${port}`);
});
