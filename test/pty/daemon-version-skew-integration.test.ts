import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDaemonCommandDependencies,
  runDaemonRestartCommand,
} from "../../packages/hunk/src/session/agent/daemonCommands";
import { resolveSessionBrokerConfig } from "../../packages/hunk/src/session/broker/brokerConfig";
import { launchSessionBrokerDaemonAndRecord } from "../../packages/hunk/src/session/broker/brokerLauncher";
import {
  HUNK_DAEMON_CLIENT_NEWER_MESSAGE,
  HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
} from "../../packages/hunk/src/session/client/daemonSkew";
import { HUNK_SESSION_DAEMON_VERSION } from "../../packages/hunk/src/session/protocol";
import { createPtyHarness } from "./harness";

/**
 * A window meeting a daemon from another build: the status bar must say which side is old and
 * what to do, and the window must attach by itself once a matching daemon replaces the old one.
 * The daemon impersonates another revision through the internal test override.
 *
 * The restart runs in this process through the command implementation the CLI calls: under
 * `bun test --no-orphans` a replacement daemon started by a short-lived spawned CLI would be
 * killed as soon as that CLI exited.
 */
const harness = createPtyHarness();
const repoRoot = process.cwd();

setDefaultTimeout(60_000);

const tempDirs: string[] = [];
const daemons: Subprocess[] = [];
/** Daemons `hunk daemon restart` spawned detached; stopped so they do not outlive the test. */
const replacementPids: number[] = [];

afterEach(async () => {
  harness.cleanup();
  for (const pid of replacementPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await Promise.allSettled(
    daemons.splice(0).map(async (daemon) => {
      try {
        daemon.kill();
      } catch {
        // Already exited.
      }
      await daemon.exited.catch(() => undefined);
    }),
  );
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Reserve one free loopback port so parallel test files cannot collide on the daemon. */
async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (!port) throw new Error("Failed to reserve a loopback port for the daemon test.");
  return port;
}

/** Write one small before/after pair to review. */
function createFilePair() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-daemon-skew-"));
  tempDirs.push(dir);
  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  writeFileSync(before, "export const value = 1;\n");
  writeFileSync(after, "export const value = 2;\n");
  return { dir, before, after };
}

/** Poll one condition until it returns a value or the timeout passes. */
async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(150);
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

/** Start a daemon on the port that claims the given session revision. */
async function startDaemonAtRevision(port: number, configHome: string, revision: number) {
  const daemon = Bun.spawn([process.execPath, "packages/hunk/src/main.tsx", "daemon", "serve"], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      HUNK_MCP_PORT: String(port),
      HUNK_INTERNAL_SESSION_DAEMON_VERSION: String(revision),
    },
  });
  daemons.push(daemon);
  await waitUntil("skewed daemon health", () => readHealth(port), 15_000);
  return daemon;
}

/** Run one Hunk CLI invocation against the test daemon port at the built revision. */
function runCli(args: string[], port: number, configHome: string) {
  const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", ...args], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_CONFIG_HOME: configHome, HUNK_MCP_PORT: String(port) },
  });
  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

/** Run `hunk daemon restart --yes` in-process against the test port. */
async function restartDaemonInProcess(port: number, configHome: string) {
  const previous = { ...process.env };
  Object.assign(process.env, { XDG_CONFIG_HOME: configHome, HUNK_MCP_PORT: String(port) });
  delete process.env.HUNK_INTERNAL_SESSION_DAEMON_VERSION;
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
            argv: [process.execPath, join(repoRoot, "packages/hunk/src/main.tsx")],
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

function launchWindow(
  fixture: ReturnType<typeof createFilePair>,
  port: number,
  configHome: string,
) {
  return harness.launchHunk({
    args: ["diff", "--files", fixture.before, fixture.after, "--mode", "unified"],
    cwd: fixture.dir,
    cols: 80,
    rows: 24,
    env: {
      XDG_CONFIG_HOME: configHome,
      // The harness disables session brokering by default; this test is about it.
      HUNK_MCP_DISABLE: "0",
      HUNK_MCP_PORT: String(port),
    },
  });
}

describe("PTY daemon version skew", () => {
  test("a window newer than the daemon says so and attaches once the daemon is replaced", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = createFilePair();
    const port = await reserveLoopbackPort();
    const oldDaemon = await startDaemonAtRevision(
      port,
      configHome,
      HUNK_SESSION_DAEMON_VERSION - 1,
    );
    const session = await launchWindow(fixture, port, configHome);

    await harness.waitForSnapshot(session, (text) => text.includes("value = 2"), 30_000);
    // Wait on text only the refined, direction-aware notice carries; the generic wait notice
    // also names the restart command.
    const refused = await harness.waitForSnapshot(
      session,
      (text) => text.includes(HUNK_DAEMON_CLIENT_NEWER_MESSAGE),
      30_000,
    );
    expect(refused).toContain("Run `hunk daemon restart`.");
    expect(refused).toContain(HUNK_DAEMON_CLIENT_NEWER_MESSAGE);

    // The command the notice names replaces the daemon; the window's own reconnect loop then
    // registers with the replacement and the sticky notice goes away.
    const restart = await restartDaemonInProcess(port, configHome);
    expect(restart.stdout).not.toContain("[stderr]");
    expect(restart.exitCode).toBe(0);
    const result = JSON.parse(restart.stdout) as {
      after: { daemon: { daemonVersion: number; pid: number } };
    };
    expect(result.after.daemon.daemonVersion).toBe(HUNK_SESSION_DAEMON_VERSION);
    replacementPids.push(result.after.daemon.pid);
    await oldDaemon.exited;

    await harness.waitForSnapshot(
      session,
      (text) => !text.includes(HUNK_DAEMON_CLIENT_NEWER_MESSAGE),
      30_000,
    );
    await waitUntil("window registered with the replacement daemon", () => {
      const listed = runCli(["session", "list", "--json"], port, configHome);
      if (listed.exitCode !== 0) return null;
      const parsed = JSON.parse(listed.stdout) as { sessions: Array<{ sessionId: string }> };
      return parsed.sessions[0]?.sessionId ?? null;
    });
  });

  test("a window older than the daemon is told to relaunch", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const fixture = createFilePair();
    const port = await reserveLoopbackPort();
    await startDaemonAtRevision(port, configHome, HUNK_SESSION_DAEMON_VERSION + 1);
    const session = await launchWindow(fixture, port, configHome);

    const refused = await harness.waitForSnapshot(
      session,
      (text) => text.includes(HUNK_DAEMON_CLIENT_OLDER_MESSAGE),
      30_000,
    );
    expect(refused).toContain(HUNK_DAEMON_CLIENT_OLDER_MESSAGE);
  });
});
