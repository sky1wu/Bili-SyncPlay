import type { PlaybackState, RoomState } from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import { t } from "../shared/i18n";

const SEEK_TOAST_THRESHOLD_SECONDS = 1.5;
const SEEK_START_TOAST_SUPPRESSION_MS = 1600;

export interface ToastCoordinatorState {
  lastRoomState: RoomState | null;
  lastSeekToastByActor: Map<string, number>;
  lastSharedVideoToastKey: string | null;
}

export function createToastCoordinatorState(): ToastCoordinatorState {
  return {
    lastRoomState: null,
    lastSeekToastByActor: new Map(),
    lastSharedVideoToastKey: null,
  };
}

export function createToastPresenter(): {
  resetMountTarget: () => void;
  show: (message: string) => void;
} {
  let toastHost: HTMLDivElement | null = null;
  let toastContainer: HTMLDivElement | null = null;

  function getToastMountTarget(): HTMLElement | null {
    return (document.fullscreenElement as HTMLElement | null) ?? document.body;
  }

  function ensureToastContainer(): HTMLDivElement | null {
    const mountTarget = getToastMountTarget();
    if (!mountTarget) {
      return null;
    }

    if (
      toastContainer?.isConnected &&
      toastHost?.parentElement === mountTarget
    ) {
      return toastContainer;
    }

    if (toastHost?.isConnected) {
      toastHost.remove();
    }

    toastHost = document.createElement("div");
    toastHost.style.position = "fixed";
    toastHost.style.inset = "0";
    toastHost.style.pointerEvents = "none";
    toastHost.style.zIndex = "2147483000";

    const shadowRoot = toastHost.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <style>
        .toast-stack {
          position: absolute;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          flex-direction: column;
          gap: 10px;
          align-items: center;
        }
        .toast {
          max-width: min(520px, calc(100vw - 32px));
          padding: 10px 14px;
          border-radius: 999px;
          background: rgba(15, 23, 42, 0.88);
          color: #f8fafc;
          font: 600 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 12px 30px rgba(15, 23, 42, 0.28);
          border: 1px solid rgba(148, 163, 184, 0.24);
          backdrop-filter: blur(14px);
        }
      </style>
      <div class="toast-stack" id="toast-stack"></div>
    `;

    mountTarget.appendChild(toastHost);
    toastContainer = shadowRoot.getElementById(
      "toast-stack",
    ) as HTMLDivElement | null;
    return toastContainer;
  }

  return {
    resetMountTarget: () => {
      toastContainer = null;
    },
    show: (message: string) => {
      const container = ensureToastContainer();
      if (!container) {
        return;
      }

      const toast = document.createElement("div");
      toast.className = "toast";
      toast.textContent = message;
      container.appendChild(toast);

      window.setTimeout(() => {
        toast.remove();
      }, 2600);
    },
  };
}

function getMemberName(
  state: RoomState,
  memberId: string | null | undefined,
): string | null {
  if (!memberId) {
    return null;
  }
  return state.members.find((member) => member.id === memberId)?.name ?? null;
}

function formatToastTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatPlaybackRate(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  if (Number.isInteger(rounded)) {
    return `${rounded.toFixed(0)}x`;
  }
  return `${rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}x`;
}

function shouldShowSeekToast(
  previousPlayback: PlaybackState,
  nextPlayback: PlaybackState,
): boolean {
  const actualDelta = nextPlayback.currentTime - previousPlayback.currentTime;
  const elapsedSeconds =
    Math.max(0, nextPlayback.serverTime - previousPlayback.serverTime) / 1000;
  const expectedDelta = elapsedSeconds * previousPlayback.playbackRate;

  if (
    previousPlayback.playState === "playing" &&
    nextPlayback.playState !== "playing"
  ) {
    return (
      Math.abs(actualDelta - expectedDelta) >= SEEK_TOAST_THRESHOLD_SECONDS
    );
  }

  if (
    previousPlayback.playState !== "playing" ||
    nextPlayback.playState !== "playing"
  ) {
    return Math.abs(actualDelta) >= SEEK_TOAST_THRESHOLD_SECONDS;
  }

  return Math.abs(actualDelta - expectedDelta) >= SEEK_TOAST_THRESHOLD_SECONDS;
}

export function getRoomStateToastMessages(args: {
  previousState: RoomState | null;
  nextState: RoomState;
  localMemberId: string | null;
  pendingRoomStateHydration: boolean;
  isCurrentPageShowingSharedVideo: boolean;
  now: number;
  lastSeekToastByActor: Map<string, number>;
}): {
  messages: string[];
  nextSeekToastByActor: Map<string, number>;
} {
  const messages: string[] = [];
  const nextSeekToastByActor = new Map(args.lastSeekToastByActor);

  if (
    !args.localMemberId ||
    !args.previousState ||
    args.previousState.roomCode !== args.nextState.roomCode
  ) {
    return { messages, nextSeekToastByActor };
  }

  const sharedVideoChanged =
    args.previousState.sharedVideo?.url !== args.nextState.sharedVideo?.url;
  const previousMembers = new Map(
    args.previousState.members.map((member) => [member.id, member.name]),
  );
  const currentMembers = new Map(
    args.nextState.members.map((member) => [member.id, member.name]),
  );

  for (const [memberId, memberName] of currentMembers) {
    if (!previousMembers.has(memberId) && memberId !== args.localMemberId) {
      messages.push(t("toastMemberJoined", { name: memberName }));
    }
  }

  for (const [memberId, memberName] of previousMembers) {
    if (!currentMembers.has(memberId) && memberId !== args.localMemberId) {
      messages.push(t("toastMemberLeft", { name: memberName }));
    }
  }

  if (
    args.pendingRoomStateHydration ||
    sharedVideoChanged ||
    !args.isCurrentPageShowingSharedVideo
  ) {
    return { messages, nextSeekToastByActor };
  }

  const shouldShowSeek = Boolean(
    args.previousState.playback &&
    args.nextState.playback &&
    args.previousState.sharedVideo?.url === args.nextState.sharedVideo?.url &&
    args.nextState.playback.actorId !== args.localMemberId &&
    shouldShowSeekToast(args.previousState.playback, args.nextState.playback),
  );

  if (
    args.previousState.playback?.playState !==
      args.nextState.playback?.playState &&
    args.nextState.playback &&
    args.nextState.playback.playState !== "buffering" &&
    args.nextState.playback.actorId !== args.localMemberId &&
    !(shouldShowSeek && args.nextState.playback.playState === "playing") &&
    !(
      args.nextState.playback.playState === "playing" &&
      nextSeekToastByActor.has(args.nextState.playback.actorId) &&
      args.now -
        (nextSeekToastByActor.get(args.nextState.playback.actorId) ?? 0) <
        SEEK_START_TOAST_SUPPRESSION_MS
    )
  ) {
    const actorName = getMemberName(
      args.nextState,
      args.nextState.playback.actorId,
    );
    if (actorName) {
      messages.push(
        args.nextState.playback.playState === "playing"
          ? t("toastStartedPlaying", { name: actorName })
          : t("toastPausedVideo", { name: actorName }),
      );
    }
  }

  if (
    args.previousState.playback &&
    args.nextState.playback &&
    args.previousState.sharedVideo?.url === args.nextState.sharedVideo?.url &&
    args.nextState.playback.actorId !== args.localMemberId &&
    Math.abs(
      args.previousState.playback.playbackRate -
        args.nextState.playback.playbackRate,
    ) > 0.01
  ) {
    const actorName = getMemberName(
      args.nextState,
      args.nextState.playback.actorId,
    );
    if (actorName) {
      messages.push(
        t("toastSwitchedRate", {
          name: actorName,
          rate: formatPlaybackRate(args.nextState.playback.playbackRate),
        }),
      );
    }
  }

  if (shouldShowSeek && args.nextState.playback) {
    const actorName = getMemberName(
      args.nextState,
      args.nextState.playback.actorId,
    );
    if (actorName) {
      nextSeekToastByActor.set(args.nextState.playback.actorId, args.now);
      messages.push(
        t("toastSeekedTo", {
          name: actorName,
          time: formatToastTime(args.nextState.playback.currentTime),
        }),
      );
    }
  }

  return { messages, nextSeekToastByActor };
}

export function getSharedVideoToastMessage(args: {
  toast: SharedVideoToastPayload | null | undefined;
  state: RoomState;
  localMemberId: string | null;
  lastSharedVideoToastKey: string | null;
  normalizedToastUrl: string | null;
  normalizedSharedUrl: string | null;
  /**
   * The normalized URL the local sharer is auto-continuing to (set while a
   * sharer-autoplay auto-share is pending confirmation). When the confirmed
   * shared video is the local member's own and matches this URL, surface a
   * dedicated "auto-continued" toast instead of staying silent — unlike a
   * manual share, the sharer did not explicitly act, so a hint is warranted.
   */
  localAutoShareTargetUrl?: string | null;
}): {
  message: string | null;
  nextSharedVideoToastKey: string | null;
} {
  if (
    !args.toast ||
    !args.localMemberId ||
    args.lastSharedVideoToastKey === args.toast.key
  ) {
    return {
      message: null,
      nextSharedVideoToastKey: args.lastSharedVideoToastKey,
    };
  }

  if (args.normalizedToastUrl !== args.normalizedSharedUrl) {
    return {
      message: null,
      nextSharedVideoToastKey: args.lastSharedVideoToastKey,
    };
  }

  if (args.toast.actorId === args.localMemberId) {
    const isLocalAutoShareContinuation =
      args.localAutoShareTargetUrl != null &&
      args.normalizedToastUrl === args.localAutoShareTargetUrl;
    return {
      message: isLocalAutoShareContinuation
        ? t("toastAutoSharedNextVideo", { title: args.toast.title })
        : null,
      nextSharedVideoToastKey: args.toast.key,
    };
  }

  const actorName = getMemberName(args.state, args.toast.actorId);
  if (!actorName) {
    return {
      message: null,
      nextSharedVideoToastKey: args.toast.key,
    };
  }

  return {
    message: t("toastSharedNewVideo", {
      name: actorName,
      title: args.toast.title,
    }),
    nextSharedVideoToastKey: args.toast.key,
  };
}
