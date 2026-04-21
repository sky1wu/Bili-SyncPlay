import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RedisHarness = {
  redisUrl: string;
  mode: "external" | "ephemeral";
  cleanup: () => Promise<void>;
};

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve a TCP port for Redis."));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForPort(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for redis-server on port ${port}.`);
}

function waitForProcessExit(processRef: ChildProcessWithoutNullStreams) {
  return new Promise<number | null>((resolve) => {
    processRef.once("exit", (code) => resolve(code));
  });
}

function waitForProcessError(processRef: ChildProcessWithoutNullStreams) {
  return new Promise<never>((_, reject) => {
    processRef.once("error", (error) => {
      reject(
        new Error(
          `Failed to start redis-server. Make sure redis-server is installed or set REDIS_URL. ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  });
}

export async function ensureRedis(required: boolean): Promise<RedisHarness> {
  const configuredRedisUrl = process.env.REDIS_URL?.trim();
  if (configuredRedisUrl) {
    return {
      redisUrl: configuredRedisUrl,
      mode: "external",
      cleanup: async () => {},
    };
  }

  if (!required) {
    return {
      redisUrl: "",
      mode: "external",
      cleanup: async () => {},
    };
  }

  const port = await reservePort();
  const directory = await mkdtemp(join(tmpdir(), "bili-syncplay-bench-redis-"));
  const processRef = spawn(
    "redis-server",
    [
      "--port",
      String(port),
      "--bind",
      "127.0.0.1",
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      directory,
      "--daemonize",
      "no",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stderrChunks: string[] = [];
  processRef.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString());
  });

  const exitPromise = waitForProcessExit(processRef);
  const errorPromise = waitForProcessError(processRef);

  try {
    await Promise.race([
      waitForPort(port, 5_000),
      errorPromise,
      exitPromise.then((code) => {
        throw new Error(
          `redis-server exited before becoming ready (code: ${String(code)}).\n${stderrChunks.join("")}`,
        );
      }),
    ]);
  } catch (error) {
    if (processRef.exitCode === null && processRef.pid !== undefined) {
      processRef.kill("SIGTERM");
    }
    await rm(directory, { force: true, recursive: true });
    throw error;
  }

  return {
    redisUrl: `redis://127.0.0.1:${port}`,
    mode: "ephemeral",
    cleanup: async () => {
      if (processRef.exitCode === null) {
        processRef.kill("SIGTERM");
        await exitPromise;
      }
      await rm(directory, { force: true, recursive: true });
    },
  };
}
