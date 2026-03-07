import type { PlaybackState, RoomState, SharedVideo } from "@bili-syncplay/protocol";

export type PopupToBackgroundMessage =
  | { type: "popup:create-room" }
  | { type: "popup:join-room"; roomCode: string }
  | { type: "popup:leave-room" }
  | { type: "popup:get-state" }
  | { type: "popup:set-server-url"; serverUrl: string };

export type ContentToBackgroundMessage =
  | { type: "content:share-video"; payload: { video: SharedVideo; playback: PlaybackState | null } }
  | { type: "content:create-room-and-share"; payload: { video: SharedVideo; playback: PlaybackState | null } }
  | { type: "content:playback-update"; payload: PlaybackState }
  | { type: "content:report-user"; payload: { displayName: string } }
  | { type: "content:get-room-state" }
  | { type: "content:get-share-context" }
  | { type: "content:debug-log"; payload: { message: string } };

export interface DebugLogEntry {
  at: number;
  scope: "background" | "content" | "server";
  message: string;
}

export type BackgroundToPopupMessage =
  | {
      type: "background:state";
      payload: {
        connected: boolean;
        roomCode: string | null;
        memberId: string | null;
        roomState: RoomState | null;
        serverUrl: string;
        error: string | null;
        retryInMs: number | null;
        clockOffsetMs: number | null;
        rttMs: number | null;
        logs: DebugLogEntry[];
      };
    };

export type BackgroundToContentMessage =
  | { type: "background:apply-room-state"; payload: RoomState }
  | { type: "background:sync-status"; payload: { roomCode: string | null; connected: boolean; memberId: string | null } };
