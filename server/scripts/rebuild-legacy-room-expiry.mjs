#!/usr/bin/env node
// Rebuilds the pre-`rooms-by-expiry` room-expiry sorted set from room bodies.
//
// ORDER MATTERS: stop every node running this build first, then run this,
// then start the old build. The scan is a plain batched read, not a snapshot,
// so a node still serving requests can change a room's expiry after this
// script has already read it — and the old build has no repair path for
// room-expiry, so that room would never be reaped again.
//
// Run this once BEFORE rolling back to a build that still reads
// `<namespace>:room-index` / `<namespace>:room-expiry`. That build rebuilds
// room-index from room bodies on startup, but has no equivalent repair for
// room-expiry, so without this step every room whose expiry was set while the
// newer build was live would be invisible to the old reaper and linger
// forever.
//
//   REDIS_URL=redis://127.0.0.1:6379 node server/scripts/rebuild-legacy-room-expiry.mjs
//
// Optional: REDIS_NAMESPACE (defaults to "bsp"), DRY_RUN=1 to only report.
//
// Safe to re-run. It never deletes room bodies and never touches
// `rooms-by-expiry`, so a run against a still-current deployment is a no-op
// beyond refreshing the legacy key.

import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("REDIS_URL is required.");
  process.exit(1);
}

// Mirrors normalizeNamespaceBase in server/src/redis-namespace.ts, which is
// the source of truth. Notably an explicitly blank REDIS_NAMESPACE is treated
// as unset there; trimming to "" here instead would rebuild ":room-expiry"
// and leave the deployment's real index untouched while reporting success.
function normalizeNamespaceBase(namespace) {
  if (!namespace || namespace.trim().length === 0) {
    return "bsp:";
  }
  const trimmed = namespace.trim();
  return trimmed.endsWith(":") ? trimmed : `${trimmed}:`;
}

const base = normalizeNamespaceBase(process.env.REDIS_NAMESPACE);
const roomKeyPrefix = `${base}room:`;
const legacyExpiryKey = `${base}room-expiry`;
const dryRun = process.env.DRY_RUN === "1";
const SCAN_COUNT = 500;

// SCAN MATCH takes a glob, so a namespace carrying glob metacharacters would
// otherwise silently match nothing.
function escapeGlobPattern(value) {
  return value.replaceAll(/[\\*?[\]]/g, (character) => `\\${character}`);
}

const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

let scanned = 0;
let expiring = 0;
let cursor = "0";

try {
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${escapeGlobPattern(roomKeyPrefix)}*`,
      "COUNT",
      SCAN_COUNT,
    );
    cursor = nextCursor;
    if (keys.length === 0) {
      continue;
    }

    const bodies = await Promise.all(keys.map((key) => redis.get(key)));
    const pending = [];
    for (const [index, raw] of bodies.entries()) {
      scanned += 1;
      if (!raw) {
        continue;
      }
      let room;
      try {
        room = JSON.parse(raw);
      } catch {
        // One unparseable body must not abort the rebuild.
        console.warn(`skipping unparseable body: ${keys[index]}`);
        continue;
      }
      if (typeof room?.code !== "string") {
        continue;
      }
      if (room.expiresAt === null || room.expiresAt === undefined) {
        pending.push(["zrem", room.code]);
      } else {
        pending.push(["zadd", room.code, String(room.expiresAt)]);
        expiring += 1;
      }
    }

    if (!dryRun && pending.length > 0) {
      const pipeline = redis.pipeline();
      for (const entry of pending) {
        if (entry[0] === "zrem") {
          pipeline.zrem(legacyExpiryKey, entry[1]);
        } else {
          pipeline.zadd(legacyExpiryKey, entry[2], entry[1]);
        }
      }
      const results = await pipeline.exec();
      for (const [error] of results ?? []) {
        if (error) {
          throw error;
        }
      }
    }
  } while (cursor !== "0");

  console.log(
    `${dryRun ? "[dry run] " : ""}scanned ${scanned} room bodies; ` +
      `${expiring} carry an expiresAt and were written to ${legacyExpiryKey}.`,
  );
} finally {
  await redis.quit();
}
