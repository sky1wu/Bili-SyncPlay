import assert from "node:assert/strict";
import test from "node:test";
import type { ClientMessage, ServerMessage } from "@bili-syncplay/protocol";
import { createVoiceController } from "../src/background/voice-controller";
import {
  VoiceRuntimeAdapterError,
  type VoiceRuntimeAdapter,
} from "../src/background/voice-runtime-adapter";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";
import { setLocaleForTests } from "../src/shared/i18n";
import type { VoiceHostConnectPayload } from "../src/shared/voice-host-messages";

function createHarness(options: { runtime?: VoiceRuntimeAdapter } = {}) {
  const runtimeState = createBackgroundRuntimeState();
  runtimeState.connection.connected = true;
  runtimeState.room.roomCode = "ROOM01";
  runtimeState.room.memberToken = "member-token-1";
  runtimeState.room.memberId = "member-1";
  const calls = {
    sent: [] as ClientMessage[],
    logs: [] as string[],
    notifyAll: 0,
  };
  const runtime = options.runtime ?? createRecordingRuntime();
  const controller = createVoiceController({
    connectionState: runtimeState.connection,
    roomSessionState: runtimeState.room,
    voiceState: runtimeState.voice,
    runtime,
    sendToServer(message) {
      calls.sent.push(message);
    },
    notifyAll() {
      calls.notifyAll += 1;
    },
    log(message) {
      calls.logs.push(message);
    },
  });
  return { runtimeState, controller, calls, runtime };
}

function createRecordingRuntime(overrides: Partial<VoiceRuntimeAdapter> = {}) {
  const calls = {
    connect: [] as VoiceHostConnectPayload[],
    microphone: [] as boolean[],
    disconnect: 0,
  };
  const runtime: VoiceRuntimeAdapter & { calls: typeof calls } = {
    calls,
    async connect(payload) {
      calls.connect.push(payload);
    },
    async setMicrophoneEnabled(enabled) {
      calls.microphone.push(enabled);
    },
    async disconnect() {
      calls.disconnect += 1;
    },
    ...overrides,
  };
  return runtime;
}

const accessGrantedMessage = {
  type: "voice:access-granted",
  payload: {
    livekitUrl: "wss://voice.example.com",
    token: "livekit-token-1234567890",
    roomName: "bili-syncplay:ROOM01",
    participantIdentity: "member-1",
    expiresAt: 1_710_000_000_000,
  },
} satisfies ServerMessage;

test("voice controller requests access for the current room member", async () => {
  const harness = createHarness();

  await harness.controller.syncRoomLifecycle();

  assert.equal(harness.runtimeState.voice.status, "requesting");
  assert.deepEqual(harness.calls.sent, [
    {
      type: "voice:access",
      payload: { memberToken: "member-token-1" },
    },
  ]);
});

test("voice controller connects after access and keeps microphone muted", async () => {
  const runtime = createRecordingRuntime();
  const harness = createHarness({ runtime });

  await harness.controller.handleServerMessage(accessGrantedMessage);

  assert.equal(harness.runtimeState.voice.status, "connected");
  assert.equal(harness.runtimeState.voice.muted, true);
  assert.deepEqual(runtime.calls.connect, [
    {
      livekitUrl: accessGrantedMessage.payload.livekitUrl,
      token: accessGrantedMessage.payload.token,
      roomName: accessGrantedMessage.payload.roomName,
      participantIdentity: accessGrantedMessage.payload.participantIdentity,
    },
  ]);
  assert.deepEqual(runtime.calls.microphone, []);
  assert.deepEqual(harness.calls.sent, [
    {
      type: "voice:state",
      payload: {
        memberToken: "member-token-1",
        connected: true,
        muted: true,
        speaking: false,
      },
    },
  ]);
});

test("voice controller enables and disables microphone only from popup toggle", async () => {
  const runtime = createRecordingRuntime();
  const harness = createHarness({ runtime });
  await harness.controller.handleServerMessage(accessGrantedMessage);
  harness.calls.sent.length = 0;

  await harness.controller.setMicrophoneEnabled(true);
  await harness.controller.setMicrophoneEnabled(false);

  assert.deepEqual(runtime.calls.microphone, [true, false]);
  assert.equal(harness.runtimeState.voice.muted, true);
  assert.deepEqual(harness.calls.sent, [
    {
      type: "voice:state",
      payload: {
        memberToken: "member-token-1",
        connected: true,
        muted: false,
        speaking: false,
      },
    },
    {
      type: "voice:state",
      payload: {
        memberToken: "member-token-1",
        connected: true,
        muted: true,
        speaking: false,
      },
    },
  ]);
});

test("voice controller keeps listener connected when microphone permission is denied", async () => {
  setLocaleForTests("en-US");
  const runtime = createRecordingRuntime({
    async setMicrophoneEnabled() {
      throw new VoiceRuntimeAdapterError("NotAllowedError", {
        permissionDenied: true,
      });
    },
  });
  const harness = createHarness({ runtime });

  try {
    await harness.controller.handleServerMessage(accessGrantedMessage);
    await harness.controller.setMicrophoneEnabled(true);
  } finally {
    setLocaleForTests(null);
  }

  assert.equal(harness.runtimeState.voice.status, "connected");
  assert.equal(harness.runtimeState.voice.muted, true);
  assert.equal(
    harness.runtimeState.voice.error,
    "Microphone permission was denied.",
  );
});

test("voice controller reports browser microphone denial without disconnecting voice", async () => {
  setLocaleForTests("en-US");
  const runtime = createRecordingRuntime();
  const harness = createHarness({ runtime });

  try {
    await harness.controller.handleServerMessage(accessGrantedMessage);
    harness.calls.sent.length = 0;
    harness.controller.reportMicrophonePermissionDenied(
      "NotAllowedError: Permission dismissed",
    );
  } finally {
    setLocaleForTests(null);
  }

  assert.equal(harness.runtimeState.voice.status, "connected");
  assert.equal(harness.runtimeState.voice.muted, true);
  assert.equal(
    harness.runtimeState.voice.error,
    "Microphone permission was denied.",
  );
  assert.deepEqual(runtime.calls.microphone, []);
  assert.deepEqual(harness.calls.sent, [
    {
      type: "voice:state",
      payload: {
        memberToken: "member-token-1",
        connected: true,
        muted: true,
        speaking: false,
      },
    },
  ]);
});

test("voice controller clears state and disconnects when room membership is lost", async () => {
  const runtime = createRecordingRuntime();
  const harness = createHarness({ runtime });
  await harness.controller.handleServerMessage(accessGrantedMessage);
  harness.calls.sent.length = 0;

  harness.runtimeState.room.roomCode = null;
  harness.runtimeState.room.memberToken = null;
  harness.runtimeState.room.memberId = null;
  await harness.controller.syncRoomLifecycle();

  assert.equal(runtime.calls.disconnect, 1);
  assert.equal(harness.runtimeState.voice.status, "idle");
  assert.deepEqual(harness.calls.sent, []);
});

test("voice controller stores remote participant voice state", async () => {
  const harness = createHarness();

  await harness.controller.handleServerMessage({
    type: "voice:state",
    payload: {
      roomCode: "ROOM01",
      memberId: "member-2",
      connected: true,
      muted: false,
      speaking: true,
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.voice.participants["member-2"], {
    memberId: "member-2",
    connected: true,
    muted: false,
    speaking: true,
  });
});
