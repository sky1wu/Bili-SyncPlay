/**
 * What `commandTimeout` actually does, proved against ioredis rather than
 * asserted from its documentation.
 *
 * The whole #271 evaluation rests on two claims about the option, and both are
 * claims about a library this repo does not own: it answers a caller on a
 * connection that has stopped replying, and it does NOT take that command off
 * the connection. The second is why no depth limit in this server may be
 * retired on the strength of it, so it is worth a test rather than a sentence.
 *
 * The fixture is a TCP server that speaks just enough RESP to complete a
 * handshake and then goes silent — the failure this whole family exists for,
 * and the one a reachable real Redis will not reproduce on demand.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { Redis } from "ioredis";
import { settleWithin } from "../src/retry-pacer.js";

function bulk(payload: string): Buffer {
  return Buffer.from(`$${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
}

/** Satisfies ioredis's ready check, and is a valid reply to anything else. */
const HANDSHAKE_REPLY = bulk(
  "# Server\r\nredis_version:7.0.0\r\nloading:0\r\n",
);

const STAR = 0x2a;
const DOLLAR = 0x24;

/**
 * Length of the complete RESP command at the front of `buffer`, or null.
 *
 * Only enough of the protocol to know when one request has fully arrived, so
 * the fixture accounts for exactly one command however TCP split or coalesced
 * the bytes. A fixture that counted `data` events would answer a coalesced pair
 * once and prove something that is not true — the same lesson #264 learned from
 * a fixture that did not model one connection with in-order replies.
 */
function completeCommandLength(buffer: Buffer): number | null {
  if (buffer.length === 0 || buffer[0] !== STAR) {
    return null;
  }
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd < 0) {
    return null;
  }
  const argumentCount = Number(buffer.subarray(1, headerEnd).toString());
  if (!Number.isInteger(argumentCount) || argumentCount < 0) {
    return null;
  }

  let offset = headerEnd + 2;
  for (let index = 0; index < argumentCount; index += 1) {
    if (buffer[offset] !== DOLLAR) {
      return null;
    }
    const lengthEnd = buffer.indexOf("\r\n", offset);
    if (lengthEnd < 0) {
      return null;
    }
    const payloadLength = Number(
      buffer.subarray(offset + 1, lengthEnd).toString(),
    );
    if (!Number.isInteger(payloadLength) || payloadLength < 0) {
      return null;
    }
    offset = lengthEnd + 2 + payloadLength + 2;
    if (offset > buffer.length) {
      return null;
    }
  }
  return offset;
}

type SilentRedis = {
  url: string;
  /** Accept commands and stop replying, keeping the socket open. */
  goSilent: () => void;
  /** Commands received since {@link SilentRedis.goSilent}. */
  unansweredCommands: () => number;
  /** Reply to the commands received while silent, in arrival order. */
  replay: (payloads: string[]) => void;
  close: () => Promise<void>;
};

async function startSilentRedis(
  /**
   * Delay before each reply while the fixture is still answering. A constant
   * delay keeps replies in arrival order, which is the only ordering ioredis
   * tolerates on one connection.
   */
  answerDelayMs = 0,
): Promise<SilentRedis> {
  let answering = true;
  let unanswered = 0;
  let live: net.Socket | null = null;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    live = socket;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A client dropping its socket is the normal end of every test here.
    socket.on("error", () => undefined);

    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const length = completeCommandLength(pending);
        if (length === null) {
          return;
        }
        pending = pending.subarray(length);
        if (answering) {
          if (answerDelayMs > 0) {
            setTimeout(() => socket.write(HANDSHAKE_REPLY), answerDelayMs);
          } else {
            socket.write(HANDSHAKE_REPLY);
          }
        } else {
          unanswered += 1;
        }
      }
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    url: `redis://127.0.0.1:${port}/0`,
    goSilent: () => {
      answering = false;
    },
    unansweredCommands: () => unanswered,
    replay: (payloads) => {
      for (const payload of payloads) {
        live?.write(bulk(payload));
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The production value is `REDIS_COMMAND_TIMEOUT_MS`; a five-second test would
 * only be a slower proof of the same mechanism. */
const TEST_COMMAND_TIMEOUT_MS = 200;

test("commandTimeout answers a caller whose connection stopped replying", async () => {
  const fixture = await startSilentRedis();
  const client = new Redis(fixture.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    commandTimeout: TEST_COMMAND_TIMEOUT_MS,
  });

  try {
    await client.connect();
    fixture.goSilent();

    const startedAt = Date.now();
    await assert.rejects(client.get("stalled"));
    // The ceiling that matters is not tightness — it is that an answer arrives
    // at all. This connection had no bound before #271, so its previous ceiling
    // was Node's 300s `requestTimeout` killing the socket underneath it.
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(fixture.unansweredCommands(), 1);
  } finally {
    client.disconnect();
    await fixture.close();
  }
});

test("without commandTimeout the same caller is never answered", async () => {
  // The control, and the reason the test above proves anything: the fixture is
  // silent in both, so a passing assertion up there has to come from the option
  // rather than from the fixture recovering. This is also, verbatim, the
  // pre-#271 behaviour of the room store, the admin session store and both
  // pub/sub buses.
  const fixture = await startSilentRedis();
  const client = new Redis(fixture.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  try {
    await client.connect();
    fixture.goSilent();

    assert.equal(await settleWithin(client.get("stalled"), 600), false);
  } finally {
    client.disconnect();
    await fixture.close();
  }
});

test("a timed-out command stays queued and keeps later replies aligned", async () => {
  // The claim that decides the other half of #271: `commandTimeout` releases
  // the CALLER, not the connection. ioredis matches every reply against its
  // queue head, so it keeps the abandoned `Command` there — the reply that
  // eventually arrives is consumed by the caller that gave up, and the next
  // caller gets its own reply rather than the stale one.
  //
  // Which is why no depth limit here may be retired because the backstop
  // exists: `append-chain`'s `maxPendingAppends` and the runtime store's
  // command admission still bound the only thing that grows.
  const fixture = await startSilentRedis();
  const client = new Redis(fixture.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    commandTimeout: TEST_COMMAND_TIMEOUT_MS,
  });

  try {
    await client.connect();
    fixture.goSilent();
    await assert.rejects(client.get("abandoned"));

    const later = client.get("later");
    // Both commands are at the fixture before either is answered, which is what
    // makes the ordering assertion below meaningful.
    await settleWithin(new Promise(() => undefined), 50);
    assert.equal(fixture.unansweredCommands(), 2);

    fixture.replay(["reply-for-abandoned", "reply-for-later"]);
    // Not "reply-for-abandoned": had the timed-out command been dropped from
    // the queue, every reply on this connection would be off by one from here
    // on, and this caller would receive the abandoned one's answer.
    assert.equal(await later, "reply-for-later");
  } finally {
    client.disconnect();
    await fixture.close();
  }
});

test("a connection that is merely slow is not judged dead", async () => {
  // The failure mode the backstop is chosen to avoid, and the reason
  // REDIS_COMMAND_TIMEOUT_MS is derived from Redis's latency distribution
  // rather than from any caller's patience: tripping on a Redis that is behind
  // converts a degraded dependency into a failed one, on every connection at
  // once. "Slow" here means answering late — NOT the indefinitely blocked
  // command the tests above use, which is a stall wearing slowness's clothes.
  const fixture = await startSilentRedis(120);
  const client = new Redis(fixture.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    commandTimeout: TEST_COMMAND_TIMEOUT_MS,
  });

  try {
    await client.connect();
    assert.equal(
      await client.get("slow"),
      "# Server\r\nredis_version:7.0.0\r\nloading:0\r\n",
    );
    assert.equal(fixture.unansweredCommands(), 0);
  } finally {
    client.disconnect();
    await fixture.close();
  }
});
