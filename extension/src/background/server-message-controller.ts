import type {
  Announcement,
  RoomState,
  ServerMessage,
} from "@bili-syncplay/protocol";

export interface ServerMessageController {
  handleServerMessage(
    message: ServerMessage,
    sourceServerUrl: string,
  ): Promise<void>;
}

export function createServerMessageController(args: {
  log: (message: string) => void;
  shouldLogIncomingMessage: (messageType: ServerMessage["type"]) => boolean;
  consumeRoomState: (roomState: RoomState) => void;
  handleRoomSessionServerMessage: (message: ServerMessage) => Promise<void>;
  receiveAnnouncement: (
    announcement: Announcement | null,
    sourceServerUrl: string,
  ) => void;
  updateClockOffset: (
    clientSendTime: number,
    serverReceiveTime: number,
    serverSendTime: number,
  ) => void;
  notifyAll: () => void;
}): ServerMessageController {
  async function handleServerMessage(
    message: ServerMessage,
    sourceServerUrl: string,
  ): Promise<void> {
    if (message.type === "room:state") {
      args.consumeRoomState(message.payload);
    } else if (args.shouldLogIncomingMessage(message.type)) {
      args.log(`<- ${message.type}`);
    }

    if (message.type === "server:announcement") {
      args.receiveAnnouncement(message.payload.announcement, sourceServerUrl);
      return;
    }

    if (message.type !== "sync:pong") {
      await args.handleRoomSessionServerMessage(message);
      return;
    }

    args.updateClockOffset(
      message.payload.clientSendTime,
      message.payload.serverReceiveTime,
      message.payload.serverSendTime,
    );
    args.notifyAll();
  }

  return {
    handleServerMessage,
  };
}
