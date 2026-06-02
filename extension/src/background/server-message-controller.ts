import type { RoomState, ServerMessage } from "@bili-syncplay/protocol";

export interface ServerMessageController {
  handleServerMessage(message: ServerMessage): Promise<void>;
}

export function createServerMessageController(args: {
  log: (message: string) => void;
  shouldLogIncomingMessage: (messageType: ServerMessage["type"]) => boolean;
  consumeRoomState: (roomState: RoomState) => void;
  handleRoomSessionServerMessage: (message: ServerMessage) => Promise<void>;
  handleVoiceServerMessage?: (message: ServerMessage) => Promise<boolean>;
  syncVoiceLifecycle?: (options?: { forceRefresh?: boolean }) => Promise<void>;
  updateClockOffset: (
    clientSendTime: number,
    serverReceiveTime: number,
    serverSendTime: number,
  ) => void;
  notifyAll: () => void;
}): ServerMessageController {
  async function handleServerMessage(message: ServerMessage): Promise<void> {
    if (message.type === "room:state") {
      args.consumeRoomState(message.payload);
    } else if (args.shouldLogIncomingMessage(message.type)) {
      args.log(`<- ${message.type}`);
    }

    const handledByVoice =
      (await args.handleVoiceServerMessage?.(message)) ?? false;
    if (handledByVoice) {
      return;
    }

    if (message.type !== "sync:pong") {
      await args.handleRoomSessionServerMessage(message);
      if (isRoomLifecycleMessage(message)) {
        await args.syncVoiceLifecycle?.({
          forceRefresh:
            message.type === "room:created" || message.type === "room:joined",
        });
      }
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

function isRoomLifecycleMessage(message: ServerMessage): boolean {
  return (
    message.type === "room:created" ||
    message.type === "room:joined" ||
    message.type === "room:state" ||
    message.type === "room:member-left"
  );
}
