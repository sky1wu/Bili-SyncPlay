import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";
import { createInMemoryRoomStore } from "../src/room-store.js";

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";
const SWEEP_INTERVAL_MS = 25;
const SCRAPE_DEADLINE_MS = 5_000;

/**
 * The reaper and the collector each have their own unit tests; this one exists
 * for the wire between them. A reaper built without its collector still sweeps,
 * still logs, still returns the right count — the only symptom is a metric that
 * reads 0 forever in production, which no unit test can see.
 */
test("a reaper sweep inside a running server moves the reclaimed-rooms counter", async () => {
  const roomStore = createInMemoryRoomStore();
  await roomStore.createRoom({
    code: "ROOM01",
    joinToken: "join-token-123456",
    createdAt: 1,
  });
  const expired = await roomStore.updateRoom("ROOM01", 0, {
    expiresAt: 1,
    lastActiveAt: 1,
  });
  assert.equal(expired.ok, true);

  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    {
      ...getDefaultPersistenceConfig(),
      roomCleanupIntervalMs: SWEEP_INTERVAL_MS,
    },
    { roomStore, serviceVersion: "0.0.0-test", logEvent: () => {} },
  );

  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }
  const metricsUrl = `http://127.0.0.1:${address.port}/metrics`;

  async function scrapeReclaimedRooms(): Promise<number> {
    const response = await fetch(metricsUrl);
    assert.equal(response.status, 200);
    const match = (await response.text()).match(
      /^bili_syncplay_rooms_expired_deleted_total (\d+)$/m,
    );
    assert.notEqual(match, null, "counter missing from /metrics");
    return Number(match![1]);
  }

  try {
    assert.equal(await scrapeReclaimedRooms(), 0);

    const deadline = Date.now() + SCRAPE_DEADLINE_MS;
    let reclaimed = 0;
    while (reclaimed === 0 && Date.now() < deadline) {
      await delay(SWEEP_INTERVAL_MS);
      reclaimed = await scrapeReclaimedRooms();
    }

    assert.equal(reclaimed, 1);
    assert.equal(await roomStore.getRoom("ROOM01"), null);
  } finally {
    await server.close();
  }
});
