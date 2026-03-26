import assert from "node:assert/strict";
import test from "node:test";
import { createMultiNodeTestKit, requestJson } from "./multi-node-test-kit.js";

test("multi-node test kit starts two room nodes and one global admin on the same redis namespace", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl);
  try {
    const roomNodeA = await kit.startRoomNode("node-a");
    const roomNodeB = await kit.startRoomNode("node-b");
    const globalAdmin = await kit.startGlobalAdmin();

    assert.notEqual(roomNodeA.httpBaseUrl, roomNodeB.httpBaseUrl);
    assert.notEqual(roomNodeA.wsUrl, roomNodeB.wsUrl);
    assert.ok(kit.namespace.startsWith("bsp:test:"));

    const token = await kit.login(globalAdmin.httpBaseUrl);
    const overview = await requestJson(
      globalAdmin.httpBaseUrl,
      "/api/admin/overview",
      {
        token,
      },
    );
    assert.equal(overview.status, 200);
    assert.equal(
      (overview.body.data as { service: { name: string } }).service.name,
      "bili-syncplay-global-admin",
    );
  } finally {
    await kit.closeAll();
  }
});
