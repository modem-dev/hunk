import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { createServer } from "node:net";

const repoRoot = process.cwd();
const spawned: Subprocess[] = [];

async function reserveLoopbackPort() {
  const listener = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 1_500,
  intervalMs = 20,
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await Bun.sleep(intervalMs);
  }
}

async function readHealth(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as { ok: boolean; pid: number };
  } catch {
    return null;
  }
}

afterEach(async () => {
  await Promise.allSettled(
    spawned.splice(0).map(async (proc) => {
      try {
        proc.kill();
      } catch {
        // Ignore processes that already exited.
      }

      await proc.exited.catch(() => undefined);
    }),
  );
});

describe("session daemon lifecycle", () => {
  test("exits cleanly after SIGTERM instead of hot-looping after server shutdown", async () => {
    const port = await reserveLoopbackPort();
    const proc = Bun.spawn(["bun", "run", "src/main.tsx", "mcp", "serve"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HUNK_MCP_PORT: String(port),
      },
    });
    spawned.push(proc);

    const health = await waitUntil("daemon health", () => readHealth(port), 3_000, 50);
    expect(health).toMatchObject({ ok: true, pid: proc.pid });

    let exited = false;
    void proc.exited.then(() => {
      exited = true;
    });

    process.kill(proc.pid, "SIGTERM");

    await waitUntil("mcp serve process exit", () => (exited ? true : null), 1_500, 25);
    await waitUntil("daemon port close", async () =>
      (await readHealth(port)) === null ? true : null,
    );
  }, 10_000);
});
