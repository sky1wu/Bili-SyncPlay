import type { PlaybackState, RoomState } from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import { t } from "../shared/i18n";
import { setShadowRootTemplate } from "./shadow-template";

const SEEK_TOAST_THRESHOLD_SECONDS = 1.5;
const SEEK_START_TOAST_SUPPRESSION_MS = 1600;

export interface ToastCoordinatorState {
  lastRoomState: RoomState | null;
  /** Monotonic timestamp of when `lastRoomState` reached us. */
  lastRoomStateAtMs: number | null;
  lastSeekToastByActor: Map<string, number>;
  lastSharedVideoToastKey: string | null;
}

export function createToastCoordinatorState(): ToastCoordinatorState {
  return {
    lastRoomState: null,
    lastRoomStateAtMs: null,
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
    setShadowRootTemplate(
      shadowRoot,
      `
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
    `,
    );

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

/**
 * Whether the room's position moved by more than playing it out can explain —
 * i.e. somebody seeked.
 *
 * The content advance is checked against *two independent* references for how
 * much time really passed, and only counts as a seek when both agree, because
 * each has its own way of lying:
 *
 * - `serverTime` deltas are immune to anything happening on this machine, but
 *   they are stamped with the server's wall clock. A server whose clock is
 *   stepped (a container or VM being resynced — a WSL dev server was seen moving
 *   ~1.9s between pings) reports an interval that never happened, and the
 *   difference lands here as a phantom jump.
 * - The locally measured interval between the two states arriving is immune to
 *   any clock being adjusted, but not to this page being starved: two states
 *   processed back to back after the main thread stalls look like no time passed
 *   at all, which reads as the room having jumped forward.
 *
 * A real seek moves the position against *both* references, so requiring both to
 * exceed the threshold removes both families of false positive. The cost is a
 * missed toast when a genuine seek coincides with a clock step or a stall —
 * cosmetic, and the next update tells the story anyway. A false toast is worse:
 * it says a peer did something they did not do.
 */
function shouldShowSeekToast(
  previousPlayback: PlaybackState,
  nextPlayback: PlaybackState,
  localElapsedMs: number,
): boolean {
  const actualDelta = nextPlayback.currentTime - previousPlayback.currentTime;
  const serverElapsedSeconds =
    Math.max(0, nextPlayback.serverTime - previousPlayback.serverTime) / 1000;
  const localElapsedSeconds = Math.max(0, localElapsedMs) / 1000;
  const unexplainedBy = (elapsedSeconds: number): number =>
    Math.abs(actualDelta - elapsedSeconds * previousPlayback.playbackRate);

  if (previousPlayback.playState !== "playing") {
    // The room was not advancing, so no amount of elapsed time explains a move:
    // any change of position since then was somebody seeking. This also covers
    // resuming from a pause, where crediting the elapsed time would report the
    // paused interval as a backwards jump.
    return Math.abs(actualDelta) >= SEEK_TOAST_THRESHOLD_SECONDS;
  }

  return (
    Math.min(
      unexplainedBy(serverElapsedSeconds),
      unexplainedBy(localElapsedSeconds),
    ) >= SEEK_TOAST_THRESHOLD_SECONDS
  );
}

export function getRoomStateToastMessages(args: {
  previousState: RoomState | null;
  nextState: RoomState;
  localMemberId: string | null;
  pendingRoomStateHydration: boolean;
  isCurrentPageShowingSharedVideo: boolean;
  /**
   * Monotonic "now", also the clock `lastSeekToastByActor` timestamps are on.
   * Monotonic so that a clock adjustment cannot widen or collapse either the
   * seek check or the suppression window.
   */
  now: number;
  /**
   * Locally measured interval between `previousState` and `nextState` arriving,
   * on the same monotonic clock as `now`. See {@link shouldShowSeekToast}.
   */
  elapsedSincePreviousStateMs: number;
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
    !args.isCurrentPageShowingSharedVideo ||
    // The sharer's shared video reached its natural end. The flushed terminal
    // paused state must be applied silently — surfacing a "paused" / "jumped to
    // <end>" toast here is misleading (the video ended on its own) and noisy
    // moments before the autoplay-next share lands.
    args.nextState.playback?.naturalEnd === true ||
    // A load/stall pause that outlived its buffering classification. The peer
    // did not pause anything — its player never started — so "<name> paused the
    // video" names an action nobody performed. Same treatment as a natural end:
    // apply the state, say nothing. Member join/leave messages already pushed
    // above still ship; only the playback-action toasts are skipped.
    args.nextState.playback?.bufferUpgrade === true
  ) {
    return { messages, nextSeekToastByActor };
  }

  const shouldShowSeek = Boolean(
    args.previousState.playback &&
    args.nextState.playback &&
    args.previousState.sharedVideo?.url === args.nextState.sharedVideo?.url &&
    args.nextState.playback.actorId !== args.localMemberId &&
    shouldShowSeekToast(
      args.previousState.playback,
      args.nextState.playback,
      args.elapsedSincePreviousStateMs,
    ),
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
