import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";
import { disconnectSocket } from "../src/background/socket-lifecycle";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSING;
  }
}

function createHarness() {
  const runtimeState = createBackgroundRuntimeState();
  const reasons: string[] = [];
  let resetReconnectCalls = 0;
  let stopClockCalls = 0;

  function run(): void {
    disconnectSocket({
      connectionState: runtimeState.connection,
      memberTokenState: runtimeState.room,
      resetReconnectState: () => {
        resetReconnectCalls += 1;
      },
      stopClockSyncTimer: () => {
        stopClockCalls += 1;
      },
      clearPendingLocalShare: (reason) => {
        reasons.push(reason);
      },
    });
  }

  return {
    runtimeState,
    run,
    reasons,
    get resetReconnectCalls() {
      return resetReconnectCalls;
    },
    get stopClockCalls() {
      return stopClockCalls;
    },
  };
}

test("disconnectSocket tears down the live socket and clears session state", () => {
  const harness = createHarness();
  const socket = new FakeWebSocket();
  harness.runtimeState.connection.socket = socket as unknown as WebSocket;
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.memberToken = "member-token-1";

  harness.run();

  assert.equal(socket.closeCalls, 1);
  assert.equal(harness.runtimeState.connection.socket, null);
  assert.equal(harness.runtimeState.connection.connected, false);
  assert.equal(harness.runtimeState.room.memberToken, null);
  assert.deepEqual(harness.reasons, ["socket disconnected"]);
  assert.equal(harness.resetReconnectCalls, 1);
  assert.equal(harness.stopClockCalls, 1);
});

test("disconnectSocket bumps connectEpoch so an in-flight probe aborts", () => {
  const harness = createHarness();
  const socket = new FakeWebSocket();
  harness.runtimeState.connection.socket = socket as unknown as WebSocket;
  const epochBefore = harness.runtimeState.connection.connectEpoch;

  harness.run();

  // The probe captures `connectEpoch` before its awaits and bails when it
  // changes; the leave must bump it so a parked reconnect cannot open a
  // room-less ghost connection after this teardown.
  assert.equal(harness.runtimeState.connection.connectEpoch, epochBefore + 1);
});

test("disconnectSocket bumps connectEpoch even when no socket has been created yet", () => {
  const harness = createHarness();
  // A probe that is still awaiting connection-check has not assigned a socket
  // yet, so the null-socket early return must still abort it.
  assert.equal(harness.runtimeState.connection.socket, null);
  const epochBefore = harness.runtimeState.connection.connectEpoch;

  harness.run();

  assert.equal(harness.runtimeState.connection.connectEpoch, epochBefore + 1);
  assert.equal(harness.runtimeState.connection.connected, false);
});

test("disconnectSocket nulls connectProbe so a later connect does not reuse it", () => {
  const harness = createHarness();
  // Simulate an in-flight probe parked on its connection-check fetch.
  harness.runtimeState.connection.connectProbe = Promise.resolve();

  harness.run();

  // The doomed probe must not be reused by a subsequent create/join `connect()`.
  assert.equal(harness.runtimeState.connection.connectProbe, null);
});
