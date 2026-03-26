import assert from "node:assert/strict";
import test from "node:test";
import {
  closeClient,
  connectClient,
  createMessageCollector,
  createMultiNodeTestKit,
  requestJson,
  waitForCondition,
} from "./multi-node-test-kit.js";

test("global admin executes cross-node kick_member and disconnect_session actions", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl);
  const nodeA = await kit.startRoomNode("node-a");
  const nodeB = await kit.startRoomNode("node-b");
  const globalAdmin = await kit.startGlobalAdmin();
  const token = await kit.login(globalAdmin.httpBaseUrl);
  const owner = await connectClient(nodeA.wsUrl);
  const joiner = await connectClient(nodeB.wsUrl);
  const ownerCollector = createMessageCollector(owner);
  const joinerCollector = createMessageCollector(joiner);

  try {
    owner.send(
      JSON.stringify({
        type: "room:create",
        payload: { displayName: "Alice" },
      }),
    );
    const created = await ownerCollector.next("room:created");
    await ownerCollector.next("room:state");

    joiner.send(
      JSON.stringify({
        type: "room:join",
        payload: {
          roomCode: (created.payload as { roomCode: string }).roomCode,
          joinToken: (created.payload as { joinToken: string }).joinToken,
          displayName: "Bob",
        },
      }),
    );
    const joined = await joinerCollector.next("room:joined");
    await joinerCollector.next("room:state");
    await ownerCollector.next("room:state");

    const roomCode = (created.payload as { roomCode: string }).roomCode;
    const roomDetail = await requestJson(
      globalAdmin.httpBaseUrl,
      `/api/admin/rooms/${roomCode}`,
      { token },
    );
    assert.equal(roomDetail.status, 200);
    const members = (
      roomDetail.body.data as {
        members: Array<{
          memberId: string;
          displayName: string;
          sessionId: string;
          instanceId?: string;
        }>;
      }
    ).members;
    const bob = members.find((member) => member.displayName === "Bob");
    const alice = members.find((member) => member.displayName === "Alice");
    assert.ok(bob);
    assert.ok(alice);
    assert.equal(bob?.instanceId, "node-b");
    assert.equal(alice?.instanceId, "node-a");

    const kickResponse = await requestJson(
      globalAdmin.httpBaseUrl,
      `/api/admin/rooms/${roomCode}/members/${bob?.memberId}/kick`,
      {
        method: "POST",
        token,
        body: { reason: "remove member from node-b" },
      },
    );
    assert.equal(kickResponse.status, 200);
    await waitForCondition(() => joiner.readyState === joiner.CLOSED);

    const ownerAfterKick = await ownerCollector.next("room:state");
    assert.equal(
      (ownerAfterKick.payload as { members: Array<unknown> }).members.length,
      1,
    );

    const kickedReconnect = await connectClient(nodeB.wsUrl);
    const reconnectCollector = createMessageCollector(kickedReconnect);
    try {
      kickedReconnect.send(
        JSON.stringify({
          type: "room:join",
          payload: {
            roomCode,
            joinToken: (created.payload as { joinToken: string }).joinToken,
            memberToken: (joined.payload as { memberToken: string }).memberToken,
            displayName: "Bob",
          },
        }),
      );
      const kickedError = await reconnectCollector.next("error");
      assert.deepEqual(kickedError.payload, {
        code: "join_token_invalid",
        message: "You were removed from the room by an admin. Rejoin the room.",
      });
    } finally {
      await closeClient(kickedReconnect);
    }

    const disconnectResponse = await requestJson(
      globalAdmin.httpBaseUrl,
      `/api/admin/sessions/${alice?.sessionId}/disconnect`,
      {
        method: "POST",
        token,
        body: { reason: "disconnect owner on node-a" },
      },
    );
    assert.equal(disconnectResponse.status, 200);
    await waitForCondition(() => owner.readyState === owner.CLOSED);

    const auditLogs = await requestJson(
      globalAdmin.httpBaseUrl,
      "/api/admin/audit-logs?page=1&pageSize=10",
      { token },
    );
    assert.equal(auditLogs.status, 200);
    const auditItems = (
      auditLogs.body.data as {
        items: Array<{
          action: string;
          targetInstanceId?: string;
          executorInstanceId?: string;
          commandStatus?: string;
        }>;
      }
    ).items;
    const kickAudit = auditItems.find((item) => item.action === "kick_member");
    const disconnectAudit = auditItems.find(
      (item) => item.action === "disconnect_session",
    );
    assert.equal(kickAudit?.targetInstanceId, "node-b");
    assert.equal(kickAudit?.executorInstanceId, "node-b");
    assert.equal(kickAudit?.commandStatus, "ok");
    assert.equal(disconnectAudit?.targetInstanceId, "node-a");
    assert.equal(disconnectAudit?.executorInstanceId, "node-a");
    assert.equal(disconnectAudit?.commandStatus, "ok");
  } finally {
    await closeClient(owner);
    await closeClient(joiner);
    await kit.closeAll();
  }
});
