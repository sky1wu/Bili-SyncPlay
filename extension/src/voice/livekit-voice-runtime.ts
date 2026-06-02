import {
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublication,
} from "livekit-client";
import type {
  VoiceHostConnectPayload,
  VoiceRuntimeEvent,
} from "../shared/voice-host-messages";
import {
  VoiceRuntimeAdapterError,
  type VoiceRuntimeAdapter,
} from "../background/voice-runtime-adapter";

export function createLiveKitVoiceRuntime(args: {
  onEvent: (event: VoiceRuntimeEvent) => void;
  log: (message: string) => void;
}): VoiceRuntimeAdapter {
  let room: Room | null = null;
  const attachedAudio = new Set<HTMLMediaElement>();

  async function connect(payload: VoiceHostConnectPayload): Promise<void> {
    await disconnect();
    const nextRoom = new Room({
      adaptiveStream: false,
      dynacast: false,
    });
    room = nextRoom;
    bindRoomEvents(nextRoom, args);
    await nextRoom.connect(payload.livekitUrl, payload.token, {
      autoSubscribe: true,
    });
    args.onEvent({
      type: "participant-state",
      participantIdentity: payload.participantIdentity,
      connected: true,
      muted: true,
      speaking: false,
    });
  }

  async function setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (!room) {
      throw new VoiceRuntimeAdapterError("Voice room is not connected.");
    }
    try {
      args.log(
        `Offscreen microphone permission state before toggle: ${await queryMicrophonePermissionState()}`,
      );
      await room.localParticipant.setMicrophoneEnabled(enabled);
    } catch (error) {
      throw new VoiceRuntimeAdapterError(formatError(error), {
        permissionDenied: isPermissionDenied(error),
      });
    }
  }

  async function disconnect(): Promise<void> {
    for (const audio of attachedAudio) {
      audio.remove();
    }
    attachedAudio.clear();
    if (room) {
      const previousRoom = room;
      room = null;
      await previousRoom.disconnect(true);
    }
  }

  return {
    connect,
    setMicrophoneEnabled,
    disconnect,
  };

  function bindRoomEvents(
    targetRoom: Room,
    runtimeArgs: {
      onEvent: (event: VoiceRuntimeEvent) => void;
      log: (message: string) => void;
    },
  ): void {
    targetRoom
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        handleTrackSubscribed(track, publication, participant, runtimeArgs);
      })
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        emitTrackMuteState(publication, participant, true, runtimeArgs);
      })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => {
        emitTrackMuteState(publication, participant, false, runtimeArgs);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        runtimeArgs.onEvent({
          type: "participant-state",
          participantIdentity: participant.identity,
          connected: false,
          muted: true,
          speaking: false,
        });
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        emitSpeakerStates(targetRoom, speakers, runtimeArgs);
      })
      .on(RoomEvent.Disconnected, () => {
        runtimeArgs.onEvent({
          type: "connection-state",
          connected: false,
        });
      })
      .on(RoomEvent.Connected, () => {
        runtimeArgs.onEvent({
          type: "connection-state",
          connected: true,
        });
      });
  }

  function handleTrackSubscribed(
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    runtimeArgs: {
      onEvent: (event: VoiceRuntimeEvent) => void;
      log: (message: string) => void;
    },
  ): void {
    if (
      track.kind !== Track.Kind.Audio ||
      !(track instanceof RemoteAudioTrack)
    ) {
      return;
    }
    const audioElement = track.attach();
    audioElement.autoplay = true;
    attachedAudio.add(audioElement);
    document.body.append(audioElement);
    const playPromise = audioElement.play();
    if (playPromise) {
      void playPromise.catch((error) => {
        runtimeArgs.onEvent({
          type: "audio-playback-failed",
          message: formatError(error),
        });
      });
    }
    runtimeArgs.onEvent({
      type: "participant-state",
      participantIdentity: participant.identity,
      connected: true,
      muted: false,
      speaking: false,
    });
  }

  function emitTrackMuteState(
    publication: TrackPublication,
    participant: Participant,
    muted: boolean,
    runtimeArgs: {
      onEvent: (event: VoiceRuntimeEvent) => void;
      log: (message: string) => void;
    },
  ): void {
    if (publication.source !== Track.Source.Microphone) {
      return;
    }
    runtimeArgs.onEvent({
      type: "participant-state",
      participantIdentity: participant.identity,
      connected: true,
      muted,
      speaking: false,
    });
  }

  function emitSpeakerStates(
    targetRoom: Room,
    speakers: Participant[],
    runtimeArgs: {
      onEvent: (event: VoiceRuntimeEvent) => void;
      log: (message: string) => void;
    },
  ): void {
    const activeSpeakerIdentities = new Set(
      speakers.map((speaker) => speaker.identity),
    );
    const participants: Participant[] = [
      targetRoom.localParticipant,
      ...Array.from(targetRoom.remoteParticipants.values()),
    ];
    for (const participant of participants) {
      const microphonePublication = Array.from(
        participant.trackPublications.values(),
      ).find((publication) => publication.source === Track.Source.Microphone);
      runtimeArgs.onEvent({
        type: "participant-state",
        participantIdentity: participant.identity,
        connected: true,
        muted: microphonePublication?.isMuted ?? true,
        speaking: activeSpeakerIdentities.has(participant.identity),
      });
    }
  }
}

function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "NotAllowedError" ||
    error.name === "PermissionDeniedError" ||
    /permission|notallowed/i.test(error.message)
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      ? `${error.name || "Error"}: ${error.message}`
      : error.name || "Error";
  }
  return String(error);
}

async function queryMicrophonePermissionState(): Promise<string> {
  const permissions = navigator.permissions;
  if (!permissions?.query) {
    return "unsupported";
  }
  try {
    const status = await permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state;
  } catch (error) {
    return `query_failed:${formatError(error)}`;
  }
}
