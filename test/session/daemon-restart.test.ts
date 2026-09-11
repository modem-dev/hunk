import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUNK_SESSION_DAEMON_VERSION } from "../../packages/hunk/src/session/protocol";
import {
  HUNK_DAEMON_CLIENT_NEWER_MESSAGE,
  HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
} from "../../packages/hunk/src/session/client/daemonSkew";
import {
  createDaemonCommandDependencies,
  runDaemonRestartCommand,
} from "../../packages/hunk/src/session/agent/daemonCommands";
import { resolveSessionBrokerConfig } from "../../packages/hunk/src/session/broker/brokerConfig";
import { launchSessionBrokerDaemonAndRecord } from "../../packages/hunk/src/session/broker/brokerLauncher";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";

/**
 * `hunk daemon restart` against a daemon from another build, with one window attached from
 * that build and one refused window from this build: the daemon is replaced by one at this
 * CLI's revision, the refused window attaches on its own, and the old window is told to
 * relaunch instead of being reattached.
 *
 * The restart itself runs in this process through the same command implementation the CLI
 * calls, because `bun test --no-orphans` kills a spawned process's descendants the moment it
 * exits: a replacement daemon started by a short-lived spawned CLI would not survive. The
 * CLI-level contract (parsing, help, non-TTY refusal) is covered by spawned runs that need no
 * daemon to outlive them.
 */
const repoRoot = process.cwd();
const sourceEntrypoint = join(repoRoot, "packages/hunk/src/main.tsx");
const testConfigHome = createTestConfigHome();
const OLD_REVISION = HUNK_SESSION_DAEMON_VERSION - 1;

afterAll(cleanupTestConfigHomes);

const spawned: Subprocess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    spawned.splice(0).map(async (proc) => {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
      await proc.exited.catch(() => undefined);
    }),
  );
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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

/**
 * Poll one condition. Each CLI-backed probe spawns a Bun process, so the ceiling is generous:
 * the full suite saturates every core and a single probe can take seconds there.
 */
async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 40_000,
  intervalMs = 250,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(intervalMs);
  }
}

async function readHealth(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok ? ((await response.json()) as { ok: boolean }) : null;
  } catch {
    return null;
  }
}

interface Environment {
  port: number;
  runtimeDir: string;
}

/** Environment for one spawned Hunk process, at the given revision (or the built one). */
function processEnv({ port, runtimeDir }: Environment, revision?: number) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_CONFIG_HOME: testConfigHome,
    XDG_RUNTIME_DIR: runtimeDir,
    HUNK_MCP_PORT: String(port),
    HUNK_DISABLE_UPDATE_NOTICE: "1",
  };
  if (revision === undefined) delete env.HUNK_INTERNAL_SESSION_DAEMON_VERSION;
  else env.HUNK_INTERNAL_SESSION_DAEMON_VERSION = String(revision);
  return env;
}

function spawnDaemon(environment: Environment, revision: number) {
  const proc = Bun.spawn([process.execPath, sourceEntrypoint, "daemon", "serve"], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: processEnv(environment, revision),
  });
  spawned.push(proc);
  return proc;
}

/** Spawn one window stand-in and collect its daemon-link notices. */
function spawnWindow(environment: Environment, sessionId: string, revision?: number) {
  const proc = Bun.spawn(
    [process.execPath, "run", join(repoRoot, "test/session/fixtures/producer-window.ts")],
    {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...processEnv(environment, revision), PRODUCER_FIXTURE_SESSION_ID: sessionId },
    },
  );
  spawned.push(proc);
  const notices: Array<string | null> = [];
  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += Buffer.from(value).toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        notices.push((JSON.parse(line) as { notice: string | null }).notice);
      }
    }
  })();
  return { proc, notices };
}

/** Run one Hunk CLI invocation to completion at the given revision. */
function runCli(args: string[], environment: Environment, revision?: number) {
  const proc = Bun.spawnSync([process.execPath, sourceEntrypoint, ...args], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: processEnv(environment, revision),
  });
  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

/**
 * Run the restart command in-process against the test daemon port, spawning the replacement
 * from Hunk's real entrypoint the way the CLI does.
 */
async function restartDaemonInProcess(environment: Environment) {
  const previous = { ...process.env };
  Object.assign(process.env, processEnv(environment));
  try {
    const config = resolveSessionBrokerConfig();
    const out: string[] = [];
    const exitCode = await runDaemonRestartCommand(
      { kind: "daemon-restart", output: "json", yes: true },
      { stdout: (text) => out.push(text), stderr: (text) => out.push(`[stderr] ${text}`) },
      {
        ...createDaemonCommandDependencies(config),
        launchDaemon: () =>
          launchSessionBrokerDaemonAndRecord({
            config,
            cwd: repoRoot,
            argv: [process.execPath, sourceEntrypoint],
          }),
      },
    );
    return { exitCode, stdout: out.join("") };
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

/** Stop a daemon the restart spawned detached, so it does not outlive the test. */
function stopSpawnedDaemon(environment: Environment) {
  const status = runCli(["daemon", "status", "--json"], environment);
  if (status.exitCode !== 0) return;
  const pid = (JSON.parse(status.stdout) as { daemon: { pid: number } | null }).daemon?.pid;
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function listSessionIds(environment: Environment, revision?: number) {
  const listed = runCli(["session", "list", "--json"], environment, revision);
  if (listed.exitCode !== 0) return null;
  const parsed = JSON.parse(listed.stdout) as { sessions: Array<{ sessionId: string }> };
  return parsed.sessions.map((session) => session.sessionId);
}

describe("hunk daemon restart", () => {
  test("replaces an older daemon and lets the refused newer window attach", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "hunk-daemon-restart-"));
    tempDirs.push(runtimeDir);
    const environment = { port: await reserveLoopbackPort(), runtimeDir };

    spawnDaemon(environment, OLD_REVISION);
    await waitUntil("old daemon health", () => readHealth(environment.port));

    // One window from the old build attaches; one from this build is refused at the hello.
    const oldWindow = spawnWindow(environment, "old-window", OLD_REVISION);
    const newWindow = spawnWindow(environment, "new-window");
    await waitUntil("old window registered", () =>
      listSessionIds(environment, OLD_REVISION)?.includes("old-window") ? true : null,
    );
    await waitUntil("new window refused", () =>
      newWindow.notices.includes(HUNK_DAEMON_CLIENT_NEWER_MESSAGE) ? true : null,
    );

    // This CLI, at the built revision, cannot drive sessions on the old daemon...
    const mismatch = runCli(["session", "list", "--json"], environment);
    expect(mismatch.exitCode).toBe(1);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({
      error: {
        kind: "daemon-build-mismatch",
        message: "The session daemon is an older Hunk build and refuses this CLI.",
        daemon: { daemonVersion: OLD_REVISION },
        cli: { daemonVersion: HUNK_SESSION_DAEMON_VERSION },
        attachedSessions: { count: 1, sessions: [{ sessionId: "old-window" }] },
        recommendedAction: "restart-daemon",
      },
    });

    // ...but it can see it and replace it.
    const status = runCli(["daemon", "status", "--json"], environment);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      daemon: { daemonVersion: OLD_REVISION },
      direction: "client-newer",
      attachedSessions: [{ sessionId: "old-window", olderBuild: true }],
    });

    const restart = await restartDaemonInProcess(environment);
    expect(restart.stdout).not.toContain("[stderr]");
    expect(restart.exitCode).toBe(0);
    const result = JSON.parse(restart.stdout) as {
      restarted: boolean;
      before: { daemon: { daemonVersion: number; pid: number } };
      after: { daemon: { daemonVersion: number; pid: number } };
    };
    expect(result.restarted).toBe(true);
    expect(result.before.daemon.daemonVersion).toBe(OLD_REVISION);
    expect(result.after.daemon.daemonVersion).toBe(HUNK_SESSION_DAEMON_VERSION);
    expect(result.after.daemon.pid).not.toBe(result.before.daemon.pid);

    // The refused window attaches by itself; the old one is told to relaunch and stays out.
    await waitUntil("new window registered with the replacement", () =>
      listSessionIds(environment)?.includes("new-window") ? true : null,
    );
    await waitUntil("old window told to relaunch", () =>
      oldWindow.notices.includes(HUNK_DAEMON_CLIENT_OLDER_MESSAGE) ? true : null,
    );
    expect(newWindow.notices.at(-1)).toBeNull();
    expect(listSessionIds(environment)).toEqual(["new-window"]);

    try {
      // The replacement is the one the status command now reports, matched to this CLI.
      expect(JSON.parse(runCli(["daemon", "status", "--json"], environment).stdout)).toMatchObject({
        daemon: { daemonVersion: HUNK_SESSION_DAEMON_VERSION, pid: result.after.daemon.pid },
        direction: "matched",
        attachedSessions: [{ sessionId: "new-window", olderBuild: false }],
      });
    } finally {
      stopSpawnedDaemon(environment);
    }
  }, 120_000);

  test("refuses to restart without --yes when stdin is not a terminal", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "hunk-daemon-restart-"));
    tempDirs.push(runtimeDir);
    const environment = { port: await reserveLoopbackPort(), runtimeDir };
    spawnDaemon(environment, HUNK_SESSION_DAEMON_VERSION);
    await waitUntil("daemon health", () => readHealth(environment.port));

    const restart = runCli(["daemon", "restart"], environment);
    expect(restart.exitCode).toBe(1);
    expect(restart.stdout).toContain("Session daemon");
    expect(restart.stderr).toContain("stdin is not a terminal");
    expect(restart.stderr).toContain("Re-run with --yes");
    expect(await readHealth(environment.port)).toEqual({ ok: true });
  }, 30_000);

  test("reports no daemon with exit 0 when none is running", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "hunk-daemon-restart-"));
    tempDirs.push(runtimeDir);
    const environment = { port: await reserveLoopbackPort(), runtimeDir };

    const status = runCli(["daemon", "status"], environment);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toBe("No session daemon is running.\n");
  }, 30_000);
});
