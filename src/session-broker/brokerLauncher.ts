import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionBrokerConfig, type ResolvedSessionBrokerConfig } from "./brokerConfig";

const SCRIPT_ENTRYPOINT_PATTERN = /[\\/]|\.(?:[cm]?js|tsx?)$/;
const DEFAULT_DAEMON_LOCK_STALE_MS = 15_000;
const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 3_000;
const DEFAULT_DAEMON_HEALTH_POLL_INTERVAL_MS = 100;

export interface DaemonLaunchCommand {
  command: string;
  args: string[];
}

export interface SessionBrokerRuntimePaths {
  runtimeDir: string;
  lockPath: string;
  metadataPath: string;
}

interface SessionBrokerLaunchLockFile {
  ownerPid: number;
  host: string;
  port: number;
  acquiredAt: string;
}

export interface SessionBrokerRuntimeMetadata {
  pid: number;
  host: string;
  port: number;
  nonce: string;
  command: string;
  args: string[];
  startedAt: string;
  launchedByPid: number;
  launchCwd: string;
}

interface SessionBrokerLaunchLock {
  release: () => void;
}

export interface SessionBrokerHealth {
  ok: boolean;
  pid: number;
  nonce: string;
  sessions?: number;
  pendingCommands?: number;
  startedAt?: string;
  uptimeMs?: number;
  sessionApi?: string;
  sessionCapabilities?: string;
  sessionSocket?: string;
  staleSessionTtlMs?: number;
}

export type SessionBrokerPortState =
  | {
      kind: "daemon";
      health: SessionBrokerHealth;
      metadata: SessionBrokerRuntimeMetadata;
    }
  | {
      kind: "foreign";
    }
  | {
      kind: "none";
    };

export interface EnsureSessionBrokerAvailableOptions {
  config?: ResolvedSessionBrokerConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  timeoutMs?: number;
  intervalMs?: number;
  lockStaleMs?: number;
  timeoutMessage?: string;
  isHealthy?: (config: ResolvedSessionBrokerConfig) => Promise<boolean>;
  isPortReachable?: (
    config: Pick<ResolvedSessionBrokerConfig, "host" | "port">,
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
/** Bun's Windows equivalent mounts the compiled bundle on a virtual B: drive. */
const BUNFS_WINDOWS_PREFIX = "b:/~bun/";

/** True when argv[1] is a Bun single-file-executable virtual path on any platform. */
function isBunfsEntrypoint(entrypoint: string) {
  if (entrypoint.startsWith(BUNFS_PREFIX)) {
    return true;
  }

  // Windows reports the virtual path with either separator depending on the shell, so
  // normalize before comparing (e.g. "B:\\~BUN\\root\\hunk.exe" or "B:/~BUN/root/hunk.exe").
  return entrypoint.replaceAll("\\", "/").toLowerCase().startsWith(BUNFS_WINDOWS_PREFIX);
}

function safeRuntimeToken(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}

function resolveRuntimeBaseDir(env: NodeJS.ProcessEnv = process.env) {
  return env.XDG_RUNTIME_DIR?.trim() || tmpdir();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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

function isValidSessionBrokerRuntimeMetadata(
  value: unknown,
): value is SessionBrokerRuntimeMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Record<string, unknown>;
  return (
    Number.isInteger(metadata.pid) &&
    (metadata.pid as number) > 0 &&
    isNonEmptyString(metadata.host) &&
    Number.isInteger(metadata.port) &&
    (metadata.port as number) > 0 &&
    isNonEmptyString(metadata.nonce) &&
    isNonEmptyString(metadata.command) &&
    isStringArray(metadata.args) &&
    isNonEmptyString(metadata.startedAt) &&
    Number.isInteger(metadata.launchedByPid) &&
    (metadata.launchedByPid as number) >= 0 &&
    isNonEmptyString(metadata.launchCwd)
  );
}

function isValidSessionBrokerHealth(value: unknown): value is SessionBrokerHealth {
  if (!value || typeof value !== "object") {
    return false;
  }

  const health = value as Record<string, unknown>;
  return (
    health.ok === true &&
    Number.isInteger(health.pid) &&
    (health.pid as number) > 0 &&
    isNonEmptyString(health.nonce)
  );
}

function readSessionBrokerRuntimeMetadataFile(path: string) {
  const metadata = readJsonFile<unknown>(path);
  return isValidSessionBrokerRuntimeMetadata(metadata) ? metadata : null;
}

function cleanStaleDaemonMetadata(paths: SessionBrokerRuntimePaths) {
  const rawMetadata = readJsonFile<{ pid?: unknown }>(paths.metadataPath);
  const pid = typeof rawMetadata?.pid === "number" ? rawMetadata.pid : null;
  if (pid === null) {
    return;
  }

  const metadata = readSessionBrokerRuntimeMetadataFile(paths.metadataPath);
  if (!metadata) {
    if (!isRunningPid(pid)) {
      removeFileIfPresent(paths.metadataPath);
    }

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
  config: ResolvedSessionBrokerConfig;
  env: NodeJS.ProcessEnv;
  staleAfterMs: number;
}): SessionBrokerLaunchLock | null {
  const paths = resolveSessionBrokerRuntimePaths(config, env);
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });

  const payload: SessionBrokerLaunchLockFile = {
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
        const current = readJsonFile<SessionBrokerLaunchLockFile>(paths.lockPath);
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

  const existing = readJsonFile<SessionBrokerLaunchLockFile>(paths.lockPath);
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

export function buildSessionBrokerRuntimeMetadata({
  config = resolveSessionBrokerConfig(),
  nonce,
  cwd = process.cwd(),
  argv = process.argv,
  execPath = process.execPath,
  pid = process.pid,
  launchedByPid = process.ppid,
}: {
  config?: Pick<ResolvedSessionBrokerConfig, "host" | "port">;
  nonce: string;
  cwd?: string;
  argv?: string[];
  execPath?: string;
  pid?: number;
  launchedByPid?: number;
}): SessionBrokerRuntimeMetadata {
  return {
    pid,
    host: config.host,
    port: config.port,
    nonce,
    command: execPath,
    args: argv.slice(1),
    startedAt: new Date().toISOString(),
    launchedByPid,
    launchCwd: cwd,
  };
}

export function writeSessionBrokerRuntimeMetadata(
  paths: SessionBrokerRuntimePaths,
  metadata: SessionBrokerRuntimeMetadata,
) {
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.metadataPath, JSON.stringify(metadata, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function removeSessionBrokerRuntimeMetadata(
  paths: SessionBrokerRuntimePaths,
  ownedBy?: Pick<SessionBrokerRuntimeMetadata, "pid" | "nonce">,
) {
  if (ownedBy) {
    const current = readSessionBrokerRuntimeMetadataFile(paths.metadataPath);
    if (!current || current.pid !== ownedBy.pid || current.nonce !== ownedBy.nonce) {
      return;
    }
  }

  removeFileIfPresent(paths.metadataPath);
}

function daemonPortConflictError(config: Pick<ResolvedSessionBrokerConfig, "host" | "port">) {
  return new Error(
    `Session broker port ${config.host}:${config.port} is already in use by another process. ` +
      `Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.`,
  );
}

export function nonHunkProcessPortConflictError(
  config: Pick<ResolvedSessionBrokerConfig, "host" | "port">,
) {
  return new Error(
    `The configured Hunk session daemon port ${config.host}:${config.port} is occupied by a non-Hunk process. ` +
      `Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.`,
  );
}

function daemonStartupTimeoutError(
  config: Pick<ResolvedSessionBrokerConfig, "host" | "port">,
  timeoutMessage?: string,
) {
  return new Error(
    timeoutMessage ??
      `Timed out waiting for the session broker daemon on ${config.host}:${config.port}. ` +
        `The app will retry in the background.`,
  );
}

async function waitForDaemonHealthWithCheck({
  config,
  timeoutMs,
  intervalMs,
  isHealthy,
}: {
  config: ResolvedSessionBrokerConfig;
  timeoutMs: number;
  intervalMs: number;
  isHealthy: (config: ResolvedSessionBrokerConfig) => Promise<boolean>;
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

/** Resolve how the current process should launch a sibling `daemon serve` process. */
export function resolveDaemonLaunchCommand(
  argv = process.argv,
  execPath = process.execPath,
): DaemonLaunchCommand {
  const entrypoint = argv[1];

  // Bun-compiled single-file executables report argv as
  //   ["bun", "/$bunfs/root/<name>", ...userArgs]         (Unix)
  //   ["bun", "B:/~BUN/root/<name>.exe", ...userArgs]     (Windows)
  // with execPath pointing to the real binary on disk.
  // Detect the virtual path and use execPath directly; letting the Windows form fall through
  // to the script-entrypoint branch would relaunch the binary with the virtual path as a bogus
  // first argument and the daemon would never start (#502).
  if (entrypoint && isBunfsEntrypoint(entrypoint)) {
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

/** Resolve the runtime paths used to coordinate one broker daemon per loopback host/port. */
export function resolveSessionBrokerRuntimePaths(
  config: Pick<ResolvedSessionBrokerConfig, "host" | "port"> = resolveSessionBrokerConfig(),
  env: NodeJS.ProcessEnv = process.env,
): SessionBrokerRuntimePaths {
  // Keep the runtime directory stable across the internal rename so in-flight upgrades still find
  // the same lock and metadata files instead of briefly racing as two different daemons.
  const runtimeDir = join(resolveRuntimeBaseDir(env), "hunk-mcp");
  const fileStem = `${safeRuntimeToken(config.host)}-${config.port}`;

  return {
    runtimeDir,
    lockPath: join(runtimeDir, `daemon-${fileStem}.lock`),
    metadataPath: join(runtimeDir, `daemon-${fileStem}.json`),
  };
}

export function readSessionBrokerRuntimeMetadata(
  config: Pick<ResolvedSessionBrokerConfig, "host" | "port"> = resolveSessionBrokerConfig(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const paths = resolveSessionBrokerRuntimePaths(config, env);
  cleanStaleDaemonMetadata(paths);
  const metadata = readSessionBrokerRuntimeMetadataFile(paths.metadataPath);
  if (!metadata) {
    return null;
  }

  return metadata.host === config.host && metadata.port === config.port ? metadata : null;
}

const INVALID_SESSION_BROKER_HEALTH = Symbol("invalid-session-broker-health");

async function fetchSessionBrokerHealthPayload(
  config: ResolvedSessionBrokerConfig,
  timeoutMs: number,
): Promise<typeof INVALID_SESSION_BROKER_HEALTH | unknown | null> {
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

    try {
      return await response.json();
    } catch {
      return INVALID_SESSION_BROKER_HEALTH;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function inspectSessionBrokerPort({
  config = resolveSessionBrokerConfig(),
  timeoutMs = 500,
  env = process.env,
}: {
  config?: ResolvedSessionBrokerConfig;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<SessionBrokerPortState> {
  const payload = await fetchSessionBrokerHealthPayload(config, timeoutMs);
  if (payload === null) {
    return { kind: "none" };
  }

  if (payload === INVALID_SESSION_BROKER_HEALTH || !isValidSessionBrokerHealth(payload)) {
    return { kind: "foreign" };
  }

  const metadata = readSessionBrokerRuntimeMetadata(config, env);
  if (!metadata || metadata.pid !== payload.pid || metadata.nonce !== payload.nonce) {
    return { kind: "foreign" };
  }

  return {
    kind: "daemon",
    health: payload,
    metadata,
  };
}

/** Read the daemon's health payload when one is reachable on the configured loopback port. */
export async function readSessionBrokerHealth(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
  timeoutMs = 500,
) {
  const portState = await inspectSessionBrokerPort({ config, timeoutMs });
  return portState.kind === "daemon" ? portState.health : null;
}

/** Check whether the loopback session broker already answers health probes. */
export async function isSessionBrokerHealthy(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
  timeoutMs = 500,
) {
  return (await readSessionBrokerHealth(config, timeoutMs))?.ok === true;
}

/** Check whether some local process is already accepting TCP connections on the daemon port. */
export function isLoopbackPortReachable(
  config: Pick<ResolvedSessionBrokerConfig, "host" | "port"> = resolveSessionBrokerConfig(),
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
export async function waitForSessionBrokerShutdown({
  config = resolveSessionBrokerConfig(),
  timeoutMs = 3_000,
  intervalMs = 100,
}: {
  config?: ResolvedSessionBrokerConfig;
  timeoutMs?: number;
  intervalMs?: number;
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isSessionBrokerHealthy(config))) {
      return true;
    }

    await Bun.sleep(intervalMs);
  }

  return false;
}

/** Wait briefly for a just-launched daemon to become reachable on its health endpoint. */
export async function waitForSessionBrokerHealth({
  config = resolveSessionBrokerConfig(),
  timeoutMs = DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
  intervalMs = DEFAULT_DAEMON_HEALTH_POLL_INTERVAL_MS,
}: {
  config?: ResolvedSessionBrokerConfig;
  timeoutMs?: number;
  intervalMs?: number;
}) {
  return waitForDaemonHealthWithCheck({
    config,
    timeoutMs,
    intervalMs,
    isHealthy: (resolvedConfig) => isSessionBrokerHealthy(resolvedConfig),
  });
}

/** Launch the broker daemon in the background without tying it to the current TTY session. */
export function launchSessionBrokerDaemon({
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

/** Ensure one healthy local session broker daemon exists, coordinating launch attempts across processes. */
export async function ensureSessionBrokerAvailable({
  config = resolveSessionBrokerConfig(),
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
  timeoutMs = DEFAULT_DAEMON_STARTUP_TIMEOUT_MS,
  intervalMs = DEFAULT_DAEMON_HEALTH_POLL_INTERVAL_MS,
  lockStaleMs = DEFAULT_DAEMON_LOCK_STALE_MS,
  timeoutMessage,
  isHealthy = (resolvedConfig) => isSessionBrokerHealthy(resolvedConfig),
  isPortReachable = isLoopbackPortReachable,
  launchDaemon = launchSessionBrokerDaemon,
}: EnsureSessionBrokerAvailableOptions = {}) {
  const paths = resolveSessionBrokerRuntimePaths(config, env);
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

        launchDaemon({ cwd, env, argv, execPath });

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

  const portState = await inspectSessionBrokerPort({ config, timeoutMs: intervalMs, env });
  if (portState.kind === "daemon") {
    return;
  }

  if (portState.kind === "foreign") {
    throw nonHunkProcessPortConflictError(config);
  }

  if (await isPortReachable(config)) {
    throw daemonPortConflictError(config);
  }

  throw daemonStartupTimeoutError(config, timeoutMessage);
}
