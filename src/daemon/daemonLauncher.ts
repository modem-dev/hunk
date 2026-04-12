import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHunkSessionDaemonConfig, type ResolvedHunkSessionDaemonConfig } from "./config";

const SCRIPT_ENTRYPOINT_PATTERN = /[\\/]|\.(?:[cm]?js|tsx?)$/;
const DEFAULT_DAEMON_LOCK_STALE_MS = 15_000;
const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 3_000;
const DEFAULT_DAEMON_HEALTH_POLL_INTERVAL_MS = 100;

export interface DaemonLaunchCommand {
  command: string;
  args: string[];
}

export interface HunkDaemonRuntimePaths {
  runtimeDir: string;
  lockPath: string;
  metadataPath: string;
}

interface HunkDaemonLaunchLockFile {
  ownerPid: number;
  host: string;
  port: number;
  acquiredAt: string;
}

interface HunkDaemonLaunchMetadata {
  pid: number;
  host: string;
  port: number;
  command: string;
  args: string[];
  launchedAt: string;
  launchedByPid: number;
  launchCwd: string;
}

interface HunkDaemonLaunchLock {
  release: () => void;
}

export interface EnsureHunkDaemonAvailableOptions {
  config?: ResolvedHunkSessionDaemonConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  timeoutMs?: number;
  intervalMs?: number;
  lockStaleMs?: number;
  timeoutMessage?: string;
  isHealthy?: (config: ResolvedHunkSessionDaemonConfig) => Promise<boolean>;
  isPortReachable?: (
    config: Pick<ResolvedHunkSessionDaemonConfig, "host" | "port">,
    timeoutMs?: number,
  ) => Promise<boolean>;
  launchDaemon?: (options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    argv?: string[];
    execPath?: string;
  }) => ChildProcess;
}

/** Detect Bun's virtual filesystem prefix used inside compiled single-file executables. */
const BUNFS_PREFIX = "/$bunfs/";

function safeRuntimeToken(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}

function resolveRuntimeBaseDir(env: NodeJS.ProcessEnv = process.env) {
  return env.XDG_RUNTIME_DIR?.trim() || tmpdir();
}

function isRunningPid(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJsonFile<T>(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function removeFileIfPresent(path: string) {
  try {
    rmSync(path, { force: true });
  } catch {
    // Ignore best-effort cleanup failures.
  }
}

function cleanStaleDaemonMetadata(paths: HunkDaemonRuntimePaths) {
  const metadata = readJsonFile<HunkDaemonLaunchMetadata>(paths.metadataPath);
  if (!metadata) {
    return;
  }

  if (!isRunningPid(metadata.pid)) {
    removeFileIfPresent(paths.metadataPath);
  }
}

function tryAcquireDaemonLaunchLock({
  config,
  env,
  staleAfterMs,
}: {
  config: ResolvedHunkSessionDaemonConfig;
  env: NodeJS.ProcessEnv;
  staleAfterMs: number;
}): HunkDaemonLaunchLock | null {
  const paths = resolveHunkDaemonRuntimePaths(config, env);
  mkdirSync(paths.runtimeDir, { recursive: true });

  const payload: HunkDaemonLaunchLockFile = {
    ownerPid: process.pid,
    host: config.host,
    port: config.port,
    acquiredAt: new Date().toISOString(),
  };

  try {
    writeFileSync(paths.lockPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    return {
      release: () => {
        const current = readJsonFile<HunkDaemonLaunchLockFile>(paths.lockPath);
        if (current?.ownerPid === payload.ownerPid) {
          removeFileIfPresent(paths.lockPath);
        }
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }

  const existing = readJsonFile<HunkDaemonLaunchLockFile>(paths.lockPath);
  if (!existing) {
    if (existsSync(paths.lockPath)) {
      try {
        const stat = statSync(paths.lockPath);
        if (Date.now() - stat.mtimeMs > staleAfterMs) {
          removeFileIfPresent(paths.lockPath);
          return tryAcquireDaemonLaunchLock({ config, env, staleAfterMs });
        }
      } catch {
        // Ignore racing readers while another process still owns the lock.
      }
    }

    return null;
  }

  const ownerAlive = isRunningPid(existing.ownerPid);

  if (!ownerAlive) {
    removeFileIfPresent(paths.lockPath);
    return tryAcquireDaemonLaunchLock({ config, env, staleAfterMs });
  }

  return null;
}

function writeDaemonLaunchMetadata(
  paths: HunkDaemonRuntimePaths,
  metadata: HunkDaemonLaunchMetadata,
) {
  writeFileSync(paths.metadataPath, JSON.stringify(metadata, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function daemonPortConflictError(config: Pick<ResolvedHunkSessionDaemonConfig, "host" | "port">) {
  return new Error(
    `Hunk session daemon port ${config.host}:${config.port} is already in use by another process. ` +
      `Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.`,
  );
}

function daemonStartupTimeoutError(
  config: Pick<ResolvedHunkSessionDaemonConfig, "host" | "port">,
  timeoutMessage?: string,
) {
  return new Error(
    timeoutMessage ??
      `Timed out waiting for the Hunk session daemon on ${config.host}:${config.port}. ` +
        `Hunk will retry in the background.`,
  );
}

async function waitForDaemonHealthWithCheck({
  config,
  timeoutMs,
  intervalMs,
  isHealthy,
}: {
  config: ResolvedHunkSessionDaemonConfig;
  timeoutMs: number;
  intervalMs: number;
  isHealthy: (config: ResolvedHunkSessionDaemonConfig) => Promise<boolean>;
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isHealthy(config)) {
      return true;
    }

    await Bun.sleep(intervalMs);
  }

  return false;
}

/** Resolve how the current Hunk process should launch a sibling `hunk daemon serve` process. */
export function resolveDaemonLaunchCommand(
  argv = process.argv,
  execPath = process.execPath,
): DaemonLaunchCommand {
  const entrypoint = argv[1];

  // Bun-compiled single-file executables report argv as
  //   ["bun", "/$bunfs/root/<name>", ...userArgs]
  // with execPath pointing to the real binary on disk.
  // Detect the virtual $bunfs path and use execPath directly.
  if (entrypoint && entrypoint.startsWith(BUNFS_PREFIX)) {
    return {
      command: execPath,
      args: ["daemon", "serve"],
    };
  }

  // Running from source or a JS wrapper (bun src/main.tsx, node bin/hunk.cjs):
  // reuse the runtime + script entrypoint.
  if (entrypoint && !entrypoint.startsWith("-") && SCRIPT_ENTRYPOINT_PATTERN.test(entrypoint)) {
    return {
      command: execPath,
      args: [entrypoint, "daemon", "serve"],
    };
  }

  return {
    command: execPath,
    args: ["daemon", "serve"],
  };
}

/** Resolve the runtime paths Hunk uses to coordinate one daemon per loopback host/port. */
export function resolveHunkDaemonRuntimePaths(
  config: Pick<ResolvedHunkSessionDaemonConfig, "host" | "port"> = resolveHunkSessionDaemonConfig(),
  env: NodeJS.ProcessEnv = process.env,
): HunkDaemonRuntimePaths {
  // Keep the runtime directory stable across the daemon rename so in-flight upgrades still find
  // the same lock and metadata files instead of briefly racing as two different daemons.
  const runtimeDir = join(resolveRuntimeBaseDir(env), "hunk-mcp");
  const fileStem = `${safeRuntimeToken(config.host)}-${config.port}`;

  return {
    runtimeDir,
    lockPath: join(runtimeDir, `daemon-${fileStem}.lock`),
    metadataPath: join(runtimeDir, `daemon-${fileStem}.json`),
  };
}

export interface HunkDaemonHealth {
  ok: boolean;
  pid?: number;
  sessions?: number;
  pendingCommands?: number;
  startedAt?: string;
  uptimeMs?: number;
  sessionApi?: string;
  sessionCapabilities?: string;
  sessionSocket?: string;
  staleSessionTtlMs?: number;
}

/** Read the daemon's health payload when one is reachable on the configured loopback port. */
export async function readHunkDaemonHealth(
  config: ResolvedHunkSessionDaemonConfig = resolveHunkSessionDaemonConfig(),
  timeoutMs = 500,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(`${config.httpOrigin}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as HunkDaemonHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Check whether the loopback Hunk daemon already answers health probes. */
export async function isHunkDaemonHealthy(
  config: ResolvedHunkSessionDaemonConfig = resolveHunkSessionDaemonConfig(),
  timeoutMs = 500,
) {
  return (await readHunkDaemonHealth(config, timeoutMs))?.ok === true;
}

/** Check whether some local process is already accepting TCP connections on the daemon port. */
export function isLoopbackPortReachable(
  config: Pick<ResolvedHunkSessionDaemonConfig, "host" | "port"> = resolveHunkSessionDaemonConfig(),
  timeoutMs = 500,
) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = connect({
      host: config.host,
      port: config.port,
    });

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Wait for the running daemon to stop responding on its health endpoint. */
export async function waitForHunkDaemonShutdown({
  config = resolveHunkSessionDaemonConfig(),
  timeoutMs = 3_000,
  intervalMs = 100,
}: {
  config?: ResolvedHunkSessionDaemonConfig;
  timeoutMs?: number;
  intervalMs?: number;
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isHunkDaemonHealthy(config))) {
      return true;
    }

    await Bun.sleep(intervalMs);
  }

  return false;
}

/** Wait briefly for a just-launched daemon to become reachable on its health endpoint. */
export async function waitForHunkDaemonHealth({
  config = resolveHunkSessionDaemonConfig(),
  timeoutMs = DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
  intervalMs = DEFAULT_DAEMON_HEALTH_POLL_INTERVAL_MS,
}: {
  config?: ResolvedHunkSessionDaemonConfig;
  timeoutMs?: number;
  intervalMs?: number;
}) {
  return waitForDaemonHealthWithCheck({
    config,
    timeoutMs,
    intervalMs,
    isHealthy: (resolvedConfig) => isHunkDaemonHealthy(resolvedConfig),
  });
}

/** Launch the Hunk daemon in the background without tying it to the current TTY session. */
export function launchHunkDaemon({
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
}: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
} = {}): ChildProcess {
  const command = resolveDaemonLaunchCommand(argv, execPath);
  const child = spawn(command.command, command.args, {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  return child;
}

/** Ensure one healthy local Hunk daemon exists, coordinating launch attempts across processes. */
export async function ensureHunkDaemonAvailable({
  config = resolveHunkSessionDaemonConfig(),
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
  timeoutMs = DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
  intervalMs = DEFAULT_DAEMON_HEALTH_POLL_INTERVAL_MS,
  lockStaleMs = DEFAULT_DAEMON_LOCK_STALE_MS,
  timeoutMessage,
  isHealthy = (resolvedConfig) => isHunkDaemonHealthy(resolvedConfig),
  isPortReachable = isLoopbackPortReachable,
  launchDaemon = launchHunkDaemon,
}: EnsureHunkDaemonAvailableOptions = {}) {
  const paths = resolveHunkDaemonRuntimePaths(config, env);
  cleanStaleDaemonMetadata(paths);

  if (await isHealthy(config)) {
    return;
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const lock = tryAcquireDaemonLaunchLock({
      config,
      env,
      staleAfterMs: lockStaleMs,
    });

    if (lock) {
      try {
        cleanStaleDaemonMetadata(paths);
        if (await isHealthy(config)) {
          return;
        }

        const launchCommand = resolveDaemonLaunchCommand(argv, execPath);
        const child = launchDaemon({ cwd, env, argv, execPath });
        writeDaemonLaunchMetadata(paths, {
          pid: child.pid ?? 0,
          host: config.host,
          port: config.port,
          command: launchCommand.command,
          args: launchCommand.args,
          launchedAt: new Date().toISOString(),
          launchedByPid: process.pid,
          launchCwd: cwd,
        });

        const ready = await waitForDaemonHealthWithCheck({
          config,
          timeoutMs,
          intervalMs,
          isHealthy,
        });
        if (ready) {
          return;
        }
      } finally {
        lock.release();
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    const ready = await waitForDaemonHealthWithCheck({
      config,
      timeoutMs: Math.min(remainingMs, intervalMs),
      intervalMs,
      isHealthy,
    });
    if (ready) {
      return;
    }

    cleanStaleDaemonMetadata(paths);
  }

  if (await isPortReachable(config)) {
    throw daemonPortConflictError(config);
  }

  throw daemonStartupTimeoutError(config, timeoutMessage);
}
