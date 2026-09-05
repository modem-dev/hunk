import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSessionBrokerAvailable,
  isLoopbackPortReachable,
  parseSessionBrokerHealth,
  readSessionBrokerLaunchFingerprint,
  resolveDaemonLaunchCommand,
  resolveSessionBrokerRuntimePaths,
} from "./brokerLauncher";
import { DeterministicLifecycleClockTest } from "../../../../../test/helpers/lifecycleClockTest";

const tempDirs: string[] = [];
const testConfig = {
  host: "127.0.0.1",
  port: 47657,
  httpOrigin: "http://127.0.0.1:47657",
  wsOrigin: "ws://127.0.0.1:47657",
};

/** Create manually settled foreign work for launcher commit-fence tests. */
function createDeferredTest<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Await one launcher result while turning a lost settlement into a bounded failure. */
async function settleWithinTestTimeout<T>(promise: Promise<T>, timeoutMs = 500) {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`Launcher work did not settle within ${timeoutMs}ms.`);
    }),
  ]);
}

/** Wait for one asynchronous test condition with an actionable bounded failure. */
async function waitUntilTest(label: string, predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

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
  test("reads only bounded exact launch metadata as a generation hint", () => {
    const runtime = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
    const paths = resolveSessionBrokerRuntimePaths(testConfig, env);
    mkdirSync(paths.runtimeDir, { recursive: true });
    const metadata = {
      pid: 123,
      host: testConfig.host,
      port: testConfig.port,
      command: "/fixture/hunk",
      args: ["daemon", "serve"],
      launchedAt: "2026-01-01T00:00:00.000Z",
      launchedByPid: 122,
      launchCwd: "/fixture",
    };
    writeFileSync(paths.metadataPath, JSON.stringify(metadata));
    const first = readSessionBrokerLaunchFingerprint(testConfig, env);
    expect(first).toBe(JSON.stringify(metadata));
    writeFileSync(paths.metadataPath, JSON.stringify({ ...metadata, pid: 124 }));
    expect(readSessionBrokerLaunchFingerprint(testConfig, env)).not.toBe(first);
    for (const malformed of [[], { ...metadata, extra: true }, { ...metadata, args: {} }]) {
      writeFileSync(paths.metadataPath, JSON.stringify(malformed));
      expect(readSessionBrokerLaunchFingerprint(testConfig, env)).toBeNull();
    }
    writeFileSync(
      paths.metadataPath,
      JSON.stringify(metadata).replace('{"pid"', '{"__proto__":true,"pid"'),
    );
    expect(readSessionBrokerLaunchFingerprint(testConfig, env)).toBeNull();
    writeFileSync(paths.metadataPath, "x".repeat(16 * 1024 + 1));
    expect(readSessionBrokerLaunchFingerprint(testConfig, env)).toBeNull();
  });

  test("strictly parses minimal and legacy health responses", () => {
    expect(parseSessionBrokerHealth({ ok: true })).toEqual({ ok: true });
    expect(
      parseSessionBrokerHealth({
        ok: true,
        pid: 123,
        sessions: 1,
        pendingCommands: 0,
        startedAt: "2026-04-15T00:00:00.000Z",
        uptimeMs: 10,
        staleSessionTtlMs: 45_000,
        paths: { health: "/health", socket: "/session" },
      }),
    ).toMatchObject({ ok: true, pid: 123, sessions: 1 });
    for (const value of [null, [], { ok: "yes" }, { ok: true, pid: 1.5 }, { ok: true, extra: 1 }]) {
      expect(parseSessionBrokerHealth(value)).toBeNull();
    }
  });
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

  test("uses execPath for Windows Bun-compiled binaries mounted on the virtual B: drive", () => {
    // On Windows, Bun single-file executables report the bundle as B:\~BUN\root\<name>.exe;
    // treating it as a script entrypoint would pass the virtual path to the relaunched
    // binary as a bogus argument (#502). Both separators appear depending on the shell.
    const realBinary =
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\hunkdiff\\node_modules\\hunkdiff-windows-x64\\bin\\hunk.exe";

    expect(
      resolveDaemonLaunchCommand(["bun", "B:/~BUN/root/hunk.exe", "diff"], realBinary),
    ).toEqual({
      command: realBinary,
      args: ["daemon", "serve"],
    });
    expect(
      resolveDaemonLaunchCommand(["bun", "B:\\~BUN\\root\\hunk.exe", "diff"], realBinary),
    ).toEqual({
      command: realBinary,
      args: ["daemon", "serve"],
    });
  });

  test("detects whether some process is already listening on the daemon port", async () => {
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const port = listener.port;
    expect(port).toBeDefined();

    try {
      await expect(isLoopbackPortReachable({ host: "127.0.0.1", port: port! })).resolves.toBe(true);
    } finally {
      listener.stop(true);
    }

    await expect(isLoopbackPortReachable({ host: "127.0.0.1", port: port! })).resolves.toBe(false);
  });

  test("coordinates concurrent ensure calls so only one launcher runs", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const clock = new DeterministicLifecycleClockTest();
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
        lifecycleClock: clock,
        isHealthy: async () => healthy,
        isPortReachable: async () => false,
        launchDaemon: () => {
          launchCount += 1;
          clock.schedule(() => {
            healthy = true;
          }, 25);
          return { pid: process.pid } as ChildProcess;
        },
      }),
    );

    await clock.flushMicrotasksTest();
    await clock.advanceByTestAsync(30);
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

  test("polls daemon health on the injected lifecycle clock", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const clock = new DeterministicLifecycleClockTest();
    let launchCount = 0;
    let settled = false;
    const ensuring = ensureSessionBrokerAvailable({
      config: testConfig,
      env,
      cwd: "/repo",
      argv: ["bun", "src/main.tsx", "diff"],
      execPath: "/usr/bin/bun",
      timeoutMs: 100,
      intervalMs: 10,
      lifecycleClock: clock,
      isHealthy: async () => clock.now() >= 20,
      isPortReachable: async () => false,
      launchDaemon: () => {
        launchCount += 1;
        return { pid: process.pid } as ChildProcess;
      },
    });
    void ensuring.then(() => {
      settled = true;
    });

    await clock.flushMicrotasksTest();
    expect({ launchCount, settled, pending: clock.pendingCountTest() }).toEqual({
      launchCount: 1,
      settled: false,
      pending: 1,
    });
    await clock.advanceByTestAsync(19);
    expect(settled).toBe(false);
    await clock.advanceByTestAsync(1);
    await ensuring;
    expect(settled).toBe(true);
    expect(clock.pendingCountTest()).toBe(0);
    expect(existsSync(resolveSessionBrokerRuntimePaths(testConfig, env).lockPath)).toBe(false);
  });

  test("uses the injected polling deadline without wall-clock waits", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const clock = new DeterministicLifecycleClockTest();
    let settled = false;
    const outcome = ensureSessionBrokerAvailable({
      config: testConfig,
      env,
      cwd: "/repo",
      argv: ["bun", "src/main.tsx", "diff"],
      execPath: "/usr/bin/bun",
      timeoutMs: 25,
      intervalMs: 10,
      lifecycleClock: clock,
      isHealthy: async () => false,
      isPortReachable: async () => false,
      launchDaemon: () => ({ pid: process.pid }) as ChildProcess,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    void outcome.then(() => {
      settled = true;
    });

    await clock.flushMicrotasksTest();
    await clock.advanceByTestAsync(29);
    expect(settled).toBe(false);
    await clock.advanceByTestAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Timed out waiting for the session broker daemon");
    expect(clock.now()).toBe(30);
    expect(clock.pendingCountTest()).toBe(0);
    expect(existsSync(resolveSessionBrokerRuntimePaths(testConfig, env).lockPath)).toBe(false);
  });

  for (const outcome of ["resolve", "reject"] as const) {
    test(`lost authority fences protected health ${outcome} and still releases the launch lock`, async () => {
      const runtimeDir = createRuntimeDir();
      const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
      const paths = resolveSessionBrokerRuntimePaths(testConfig, env);
      const protectedHealth = createDeferredTest<boolean>();
      let healthCalls = 0;
      let authorized = true;
      let launchCount = 0;
      const ensuring = ensureSessionBrokerAvailable({
        config: testConfig,
        env,
        timeoutMs: 100,
        isCommitAuthorized: () => authorized,
        isHealthy: async () => {
          healthCalls += 1;
          if (healthCalls === 1) return false;
          return protectedHealth.promise;
        },
        isPortReachable: async () => false,
        launchDaemon: () => {
          launchCount += 1;
          return { pid: process.pid } as ChildProcess;
        },
      });

      await waitUntilTest("protected health probe", () => healthCalls >= 2);
      expect(existsSync(paths.lockPath)).toBe(true);
      authorized = false;
      if (outcome === "resolve") protectedHealth.resolve(false);
      else protectedHealth.reject(new Error("late protected health failure"));
      await ensuring;

      expect(launchCount).toBe(0);
      expect(existsSync(paths.lockPath)).toBe(false);
      expect(existsSync(paths.metadataPath)).toBe(false);
    });

    test(`lost authority fences final port ${outcome} without a late conflict or timeout`, async () => {
      const runtimeDir = createRuntimeDir();
      const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
      const portProbe = createDeferredTest<boolean>();
      let portStarted = false;
      let authorized = true;
      const ensuring = ensureSessionBrokerAvailable({
        config: testConfig,
        env,
        timeoutMs: 0,
        isCommitAuthorized: () => authorized,
        isHealthy: async () => false,
        isPortReachable: async () => {
          portStarted = true;
          return portProbe.promise;
        },
      });

      await waitUntilTest("final port probe", () => portStarted);
      authorized = false;
      if (outcome === "resolve") portProbe.resolve(true);
      else portProbe.reject(new Error("late port failure"));
      await ensuring;
    });
  }

  test("fences a synchronous foreign throw after authority changes", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const paths = resolveSessionBrokerRuntimePaths(testConfig, env);
    let authorized = true;
    let launchCount = 0;
    let portCalls = 0;
    const ensuring = ensureSessionBrokerAvailable({
      config: testConfig,
      env,
      isCommitAuthorized: () => authorized,
      isHealthy: () => {
        mkdirSync(paths.runtimeDir, { recursive: true });
        writeFileSync(
          paths.metadataPath,
          JSON.stringify({
            pid: process.pid,
            host: testConfig.host,
            port: testConfig.port,
            command: "/fixture/hunk",
            args: ["daemon", "serve"],
            launchedAt: new Date(0).toISOString(),
            launchedByPid: process.pid,
            launchCwd: "/fixture",
          }),
        );
        authorized = false;
        throw new Error("late synchronous health failure");
      },
      isPortReachable: async () => {
        portCalls += 1;
        return false;
      },
      launchDaemon: () => {
        launchCount += 1;
        return { pid: process.pid } as ChildProcess;
      },
    });

    await settleWithinTestTimeout(ensuring);
    expect(launchCount).toBe(0);
    expect(portCalls).toBe(0);
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(existsSync(paths.metadataPath)).toBe(true);
  });

  test("suppresses a synchronous launch error after the callback revokes authority", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const paths = resolveSessionBrokerRuntimePaths(testConfig, env);
    let authorized = true;
    let healthCalls = 0;
    const ensuring = ensureSessionBrokerAvailable({
      config: testConfig,
      env,
      timeoutMs: 100,
      isCommitAuthorized: () => authorized,
      isHealthy: async () => {
        healthCalls += 1;
        return false;
      },
      isPortReachable: async () => false,
      launchDaemon: () => {
        authorized = false;
        throw new Error("stale synchronous launch failure");
      },
    });

    await settleWithinTestTimeout(ensuring);
    expect(healthCalls).toBe(2);
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(existsSync(paths.metadataPath)).toBe(false);
  });

  test("preserves a synchronous launch error while authority remains current", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const paths = resolveSessionBrokerRuntimePaths(testConfig, env);
    const launchFailure = new Error("current synchronous launch failure");
    const ensuring = ensureSessionBrokerAvailable({
      config: testConfig,
      env,
      timeoutMs: 100,
      isCommitAuthorized: () => true,
      isHealthy: async () => false,
      isPortReachable: async () => false,
      launchDaemon: () => {
        throw launchFailure;
      },
    });

    await expect(settleWithinTestTimeout(ensuring)).rejects.toBe(launchFailure);
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(existsSync(paths.metadataPath)).toBe(false);
  });

  test("does not clean stale metadata after authority is already lost", async () => {
    const runtimeDir = createRuntimeDir();
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const paths = resolveSessionBrokerRuntimePaths(testConfig, env);
    mkdirSync(paths.runtimeDir, { recursive: true });
    writeFileSync(
      paths.metadataPath,
      JSON.stringify({
        pid: 999999,
        host: testConfig.host,
        port: testConfig.port,
        command: "/fixture/hunk",
        args: ["daemon", "serve"],
        launchedAt: new Date(0).toISOString(),
        launchedByPid: 999999,
        launchCwd: "/fixture",
      }),
    );

    await ensureSessionBrokerAvailable({
      config: testConfig,
      env,
      isCommitAuthorized: () => false,
    });
    expect(existsSync(paths.metadataPath)).toBe(true);
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
