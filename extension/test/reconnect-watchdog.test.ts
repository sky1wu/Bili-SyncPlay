import assert from "node:assert/strict";
import test from "node:test";
import {
  RECONNECT_WATCHDOG_ALARM,
  RECONNECT_WATCHDOG_PERIOD_MINUTES,
  registerReconnectWatchdog,
  type ReconnectWatchdogAlarms,
} from "../src/background/reconnect-watchdog";

function createFakeAlarms() {
  const listeners: Array<(alarm: { name: string }) => void> = [];
  const createCalls: Array<{
    name: string;
    alarmInfo: { periodInMinutes: number };
  }> = [];
  const alarms: ReconnectWatchdogAlarms = {
    create(name, alarmInfo) {
      createCalls.push({ name, alarmInfo });
    },
    onAlarm: {
      addListener(callback) {
        listeners.push(callback);
      },
    },
  };
  return {
    alarms,
    createCalls,
    fire(name: string) {
      for (const listener of listeners) {
        listener({ name });
      }
    },
  };
}

test("registers a periodic alarm and reconnects an offline session when it fires", () => {
  const fake = createFakeAlarms();
  const connectCalls: number[] = [];
  registerReconnectWatchdog({
    alarms: fake.alarms,
    shouldReconnect: () => true,
    connect: () => {
      connectCalls.push(1);
    },
    log: () => {},
  });

  assert.deepEqual(fake.createCalls, [
    {
      name: RECONNECT_WATCHDOG_ALARM,
      alarmInfo: { periodInMinutes: RECONNECT_WATCHDOG_PERIOD_MINUTES },
    },
  ]);

  fake.fire(RECONNECT_WATCHDOG_ALARM);
  assert.equal(connectCalls.length, 1);
});

test("ignores foreign alarms and does not reconnect when the session does not need it", () => {
  const fake = createFakeAlarms();
  const connectCalls: number[] = [];
  let shouldReconnect = false;
  registerReconnectWatchdog({
    alarms: fake.alarms,
    shouldReconnect: () => shouldReconnect,
    connect: () => {
      connectCalls.push(1);
    },
    log: () => {},
  });

  // Connected / no-room sessions must not trigger a connect.
  fake.fire(RECONNECT_WATCHDOG_ALARM);
  assert.equal(connectCalls.length, 0);

  // Alarms owned by other features are none of the watchdog's business.
  shouldReconnect = true;
  fake.fire("some-other-alarm");
  assert.equal(connectCalls.length, 0);

  fake.fire(RECONNECT_WATCHDOG_ALARM);
  assert.equal(connectCalls.length, 1);
});
