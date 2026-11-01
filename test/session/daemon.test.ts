import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";
import { removeTestDirectory } from "../helpers/filesystem";

const repoRoot = process.cwd();
// Spawned hunk processes must assert built-in defaults, not the developer's ambient user config.
const testConfigHome = createTestConfigHome();
// Spawned daemons mint credentials here, never in the developer's real runtime dir.
const testRuntimeDir = mkdtempSync(join(tmpdir(), "hunk-session-daemon-runtime-"));

afterAll(cleanupTestConfigHomes);
afterAll(() => removeTestDirectory(testRuntimeDir));
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

    return (await response.json()) as { ok: boolean };
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
    // Invoke the Bun executable directly so this handle owns the daemon on Windows instead of a
    // `bun run` launcher that can exit before its child releases the listening socket.
    const proc = Bun.spawn([process.execPath, "packages/hunk/src/main.tsx", "daemon", "serve"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: testConfigHome,
        XDG_RUNTIME_DIR: testRuntimeDir,
        HUNK_MCP_PORT: String(port),
      },
    });
    spawned.push(proc);

    const health = await waitUntil("daemon health", () => readHealth(port), 3_000, 50);
    expect(health).toMatchObject({ ok: true });

    let exited = false;
    void proc.exited.then(() => {
      exited = true;
    });

    // This test owns the spawned process handle; public health intentionally exposes no PID.
    proc.kill("SIGTERM");

    await waitUntil("daemon serve process exit", () => (exited ? true : null), 1_500, 25);
    await waitUntil("daemon port close", async () =>
      (await readHealth(port)) === null ? true : null,
    );
  }, 10_000);
});
