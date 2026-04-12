import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSessionBrokerAvailable,
  isLoopbackPortReachable,
  resolveDaemonLaunchCommand,
  resolveSessionBrokerRuntimePaths,
} from "./brokerLauncher";

const tempDirs: string[] = [];
const testConfig = {
  host: "127.0.0.1",
  port: 47657,
  httpOrigin: "http://127.0.0.1:47657",
  wsOrigin: "ws://127.0.0.1:47657",
};

function createRuntimeDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-session-daemon-launcher-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("session daemon launcher", () => {
  test("reuses the current script entrypoint when Hunk is running from source or a JS wrapper", () => {
    expect(resolveDaemonLaunchCommand(["bun", "src/main.tsx", "diff"], "/usr/bin/bun")).toEqual({
      command: "/usr/bin/bun",
      args: ["src/main.tsx", "daemon", "serve"],
    });

    expect(
      resolveDaemonLaunchCommand(["node", "/app/bin/hunk.cjs", "diff"], "/usr/bin/node"),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["/app/bin/hunk.cjs", "daemon", "serve"],
    });
  });

  test("falls back to relaunching the current executable when no script entrypoint is present", () => {
    expect(
      resolveDaemonLaunchCommand(["/usr/local/bin/hunk", "diff"], "/usr/local/bin/hunk"),
    ).toEqual({
      command: "/usr/local/bin/hunk",
      args: ["daemon", "serve"],
    });
  });

  test("uses execPath for Bun-compiled binaries where argv contains $bunfs virtual paths", () => {
    // In Bun single-file executables, argv is ["bun", "/$bunfs/root/<name>", ...userArgs]
    // and execPath is the real binary on disk.
    expect(
      resolveDaemonLaunchCommand(
        ["bun", "/$bunfs/root/hunk", "show"],
        "/usr/local/lib/node_modules/hunkdiff/node_modules/hunkdiff-darwin-arm64/bin/hunk",
      ),
    ).toEqual({
      command: "/usr/local/lib/node_modules/hunkdiff/node_modules/hunkdiff-darwin-arm64/bin/hunk",
      args: ["daemon", "serve"],
    });
  });

  test("detects whether some process is already listening on the daemon port", async () => {
    const listener = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });

    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await expect(isLoopbackPortReachable({ host: "127.0.0.1", port })).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }

    await expect(isLoopbackPortReachable({ host: "127.0.0.1", port })).resolves.toBe(false);
  });

  test("coordinates concurrent ensure calls so only one launcher runs", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    let healthy = false;
    let launchCount = 0;

    const ensureCalls = Array.from({ length: 6 }, () =>
      ensureSessionBrokerAvailable({
        config: testConfig,
        env,
        cwd: "/repo",
        argv: ["bun", "src/main.tsx", "diff"],
        execPath: "/usr/bin/bun",
        timeoutMs: 300,
        intervalMs: 10,
        isHealthy: async () => healthy,
        isPortReachable: async () => false,
        launchDaemon: () => {
          launchCount += 1;
          const timer = setTimeout(() => {
            healthy = true;
          }, 25);
          timer.unref?.();
          return { pid: process.pid } as ChildProcess;
        },
      }),
    );

    await expect(Promise.all(ensureCalls)).resolves.toHaveLength(6);
    expect(launchCount).toBe(1);

    const paths = resolveSessionBrokerRuntimePaths(testConfig, env);
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(JSON.parse(readFileSync(paths.metadataPath, "utf8"))).toMatchObject({
      pid: process.pid,
      host: "127.0.0.1",
      port: 47657,
      command: "/usr/bin/bun",
      args: ["src/main.tsx", "daemon", "serve"],
    });
  });

  test("recovers a stale launch lock from a dead launcher and overwrites stale metadata", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const paths = resolveSessionBrokerRuntimePaths(testConfig, env);
    mkdirSync(paths.runtimeDir, { recursive: true });

    writeFileSync(
      paths.lockPath,
      JSON.stringify(
        {
          ownerPid: 999999,
          host: testConfig.host,
          port: testConfig.port,
          acquiredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    writeFileSync(
      paths.metadataPath,
      JSON.stringify(
        {
          pid: 999999,
          host: testConfig.host,
          port: testConfig.port,
          command: "/usr/bin/bun",
          args: ["src/main.tsx", "daemon", "serve"],
          launchedAt: new Date(0).toISOString(),
          launchedByPid: 999999,
          launchCwd: "/stale",
        },
        null,
        2,
      ),
    );

    let healthy = false;
    let launchCount = 0;

    await ensureSessionBrokerAvailable({
      config: testConfig,
      env,
      cwd: "/repo",
      argv: ["bun", "src/main.tsx", "diff"],
      execPath: "/usr/bin/bun",
      timeoutMs: 300,
      intervalMs: 10,
      isHealthy: async () => healthy,
      isPortReachable: async () => false,
      launchDaemon: () => {
        launchCount += 1;
        healthy = true;
        return { pid: 54321 } as ChildProcess;
      },
    });

    expect(launchCount).toBe(1);
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(JSON.parse(readFileSync(paths.metadataPath, "utf8"))).toMatchObject({
      pid: 54321,
      launchedByPid: process.pid,
      launchCwd: "/repo",
    });
  });
});
