import assert from "node:assert/strict";
import test from "node:test";
import { createMultiNodeTestKit, requestJson } from "./multi-node-test-kit.js";

test("admin bearer sessions are shared across room nodes and revoked globally on logout", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl);
  const nodeA = await kit.startRoomNode("node-a", {
    adminUiConfig: {
      enabled: true,
      demoEnabled: false,
    },
  });
  const nodeB = await kit.startRoomNode("node-b", {
    adminUiConfig: {
      enabled: true,
      demoEnabled: false,
    },
  });

  try {
    const token = await kit.login(nodeA.httpBaseUrl);

    const meOnB = await requestJson(nodeB.httpBaseUrl, "/api/admin/me", {
      token,
    });
    assert.equal(meOnB.status, 200);
    assert.equal((meOnB.body.data as { username: string }).username, "admin");

    const logoutOnB = await requestJson(
      nodeB.httpBaseUrl,
      "/api/admin/auth/logout",
      {
        method: "POST",
        token,
      },
    );
    assert.equal(logoutOnB.status, 200);

    const meOnAAfterLogout = await requestJson(
      nodeA.httpBaseUrl,
      "/api/admin/me",
      {
        token,
      },
    );
    assert.equal(meOnAAfterLogout.status, 401);
  } finally {
    await kit.closeAll();
  }
});
