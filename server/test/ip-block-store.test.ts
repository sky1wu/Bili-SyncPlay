import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIpAddress } from "../src/ip-address.js";
import {
  createInMemoryIpBlockStore,
  type IpBlockRecord,
} from "../src/admin/ip-block-store.js";
import { createRedisIpBlockStore } from "../src/admin/redis-ip-block-store.js";

const REDIS_URL = process.env.REDIS_URL;

function createRecord(ip: string, createdAt: number): IpBlockRecord {
  return {
    ip,
    createdAt,
    actor: {
      adminId: "admin-1",
      username: "admin",
      role: "admin",
    },
    reason: "manual block",
  };
}

function createRedisKeyPrefix(): string {
  return `bsp:test:ip-blocks:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

test("normalizeIpAddress accepts IPv4, IPv6, and IPv4-mapped IPv6 values", () => {
  assert.equal(normalizeIpAddress(" 203.0.113.4 "), "203.0.113.4");
  assert.equal(normalizeIpAddress("[2001:db8::1]"), "2001:db8::1");
  assert.equal(normalizeIpAddress("::ffff:203.0.113.4"), "203.0.113.4");
  assert.equal(normalizeIpAddress("not-an-ip"), null);
});

test("in-memory IP block store adds, lists, and deletes normalized records", async () => {
  const store = createInMemoryIpBlockStore();
  const first = await store.add(createRecord("203.0.113.4", 100));
  assert.equal(first.created, true);
  assert.equal(first.record.ip, "203.0.113.4");

  const duplicate = await store.add(createRecord("203.0.113.4", 200));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.createdAt, 100);

  const listed = await store.list();
  assert.deepEqual(
    listed.map((record) => record.ip),
    ["203.0.113.4"],
  );
  assert.equal(await store.has("203.0.113.4"), true);

  listed[0]!.reason = "mutated";
  assert.equal((await store.get("203.0.113.4"))?.reason, "manual block");

  const deleted = await store.delete("203.0.113.4");
  assert.equal(deleted, true);
  assert.equal(await store.has("203.0.113.4"), false);
  assert.equal(await store.delete("203.0.113.4"), false);
});

test("redis IP block store shares records across instances", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createRedisKeyPrefix();
  const storeA = await createRedisIpBlockStore(REDIS_URL, { keyPrefix });
  const storeB = await createRedisIpBlockStore(REDIS_URL, { keyPrefix });

  try {
    const first = await storeA.add(createRecord("::ffff:203.0.113.9", 100));
    assert.equal(first.created, true);
    assert.equal(first.record.ip, "203.0.113.9");

    const duplicate = await storeB.add(createRecord("203.0.113.9", 200));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.createdAt, 100);

    assert.equal(await storeB.has("203.0.113.9"), true);
    assert.deepEqual(
      (await storeA.list()).map((record) => record.ip),
      ["203.0.113.9"],
    );

    assert.equal(await storeB.delete("203.0.113.9"), true);
    assert.equal(await storeA.has("203.0.113.9"), false);
  } finally {
    await storeA.close();
    await storeB.close();
  }
});
