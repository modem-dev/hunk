import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNativeSessionBrokerLifecycleClock,
  type SessionBrokerLifecycleClock,
} from "@hunk/session-broker";
import {
  parseBrokerSafeInteger,
  parseBrokerString,
  parseExactBrokerRecord,
} from "@hunk/session-broker-core";
import { resolveCurrentHunkCommand } from "../../core/process/relaunch";
import { resolveSessionBrokerConfig, type ResolvedSessionBrokerConfig } from "./brokerConfig";
const DEFAULT_DAEMON_LOCK_STALE_MS = 15_000;
const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 3_000;
const DEFAULT_DAEMON_HEALTH_POLL_INTERVAL_MS = 100;
const MAX_DAEMON_LAUNCH_METADATA_BYTES = 16 * 1024;

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

interface SessionBrokerLaunchMetadata {
  pid: number;
  host: string;
  port: number;
  command: string;
  args: string[];
  launchedAt: string;
  launchedByPid: number;
  launchCwd: string;
}

interface SessionBrokerLaunchLock {
  release: () => void;
}

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
  lifecycleClock?: SessionBrokerLifecycleClock;
  /** Fence commits when the caller's exact lifecycle attempt no longer owns the result. */
  isCommitAuthorized?: () => boolean;
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

function safeRuntimeToken(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}

function resolveRuntimeBaseDir(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.XDG_RUNTIME_DIR?.trim();
  if (configured) return configured;
  // Unix temporary directories are commonly shared across users. Keep the fallback beneath the
  // current home directory instead of a predictable shared-/tmp name another account can pre-own.
  return typeof process.getuid === "function" ? join(homedir(), ".hunk") : tmpdir();
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

/** Parse exact launch metadata used only as a change-detection hint across daemon generations. */
function parseSessionBrokerLaunchMetadata(value: unknown): SessionBrokerLaunchMetadata | null {
  try {
    const record = parseExactBrokerRecord(value, [
      "pid",
      "host",
      "port",
      "command",
      "args",
      "launchedAt",
      "launchedByPid",
      "launchCwd",
    ] as const);
    if (!Array.isArray(record.args)) return null;
    const args = record.args.map((argument) => parseBrokerString(argument));
    return {
      pid: parseBrokerSafeInteger(record.pid, { minimum: 1 }),
      host: parseBrokerString(record.host),
      port: parseBrokerSafeInteger(record.port, {
        minimum: 1,
        maximum: 65_535,
      }),
      command: parseBrokerString(record.command),
      args,
      launchedAt: parseBrokerString(record.launchedAt),
      launchedByPid: parseBrokerSafeInteger(record.launchedByPid, {
        minimum: 1,
      }),
      launchCwd: parseBrokerString(record.launchCwd),
    };
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

function cleanStaleDaemonMetadata(paths: SessionBrokerRuntimePaths) {
  const metadata = readJsonFile<SessionBrokerLaunchMetadata>(paths.metadataPath);
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
  lifecycleClock,
}: {
  config: ResolvedSessionBrokerConfig;
  env: NodeJS.ProcessEnv;
  staleAfterMs: number;
  lifecycleClock: SessionBrokerLifecycleClock;
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
        if (lifecycleClock.now() - stat.mtimeMs > staleAfterMs) {
          removeFileIfPresent(paths.lockPath);
          return tryAcquireDaemonLaunchLock({
            config,
            env,
            staleAfterMs,
            lifecycleClock,
          });
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
    return tryAcquireDaemonLaunchLock({
      config,
      env,
      staleAfterMs,
      lifecycleClock,
    });
  }

  return null;
}

function writeDaemonLaunchMetadata(
  paths: SessionBrokerRuntimePaths,
  metadata: SessionBrokerLaunchMetadata,
) {
  writeFileSync(paths.metadataPath, JSON.stringify(metadata, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function daemonPortConflictError(config: Pick<ResolvedSessionBrokerConfig, "host" | "port">) {
  return new Error(
    `Session broker port ${config.host}:${config.port} is already in use by another process. ` +
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

type ForeignSettlement<T> = { current: true; value: T } | { current: false };

/** Invoke synchronous foreign work and refuse values or errors after commit authority changes. */
function settleForeignCall<T>(
  work: () => T,
  isCommitAuthorized: () => boolean,
): ForeignSettlement<T> {
  try {
    const value = work();
    return isCommitAuthorized() ? { current: true, value } : { current: false };
  } catch (error) {
    if (!isCommitAuthorized()) return { current: false };
    throw error;
  }
}

/** Invoke asynchronous foreign work and refuse both late values and errors after authority changes. */
async function settleForeignWork<T>(
  work: () => Promise<T>,
  isCommitAuthorized: () => boolean,
): Promise<ForeignSettlement<T>> {
  try {
    const value = await work();
    return isCommitAuthorized() ? { current: true, value } : { current: false };
  } catch (error) {
    if (!isCommitAuthorized()) return { current: false };
    throw error;
  }
}

async function waitForDaemonHealthWithCheck({
  config,
  timeoutMs,
  intervalMs,
  lifecycleClock,
  isHealthy,
  isCommitAuthorized,
}: {
  config: ResolvedSessionBrokerConfig;
  timeoutMs: number;
  intervalMs: number;
  lifecycleClock: SessionBrokerLifecycleClock;
  isHealthy: (config: ResolvedSessionBrokerConfig) => Promise<boolean>;
  isCommitAuthorized: () => boolean;
}): Promise<"ready" | "timeout" | "stale"> {
  const deadline = lifecycleClock.now() + timeoutMs;

  while (isCommitAuthorized() && lifecycleClock.now() < deadline) {
    const health = await settleForeignWork(() => isHealthy(config), isCommitAuthorized);
    if (!health.current) return "stale";
    if (health.value) return "ready";

    const delay = await settleForeignWork(
      () => lifecycleClock.delay(intervalMs),
      isCommitAuthorized,
    );
    if (!delay.current) return "stale";
  }

  return isCommitAuthorized() ? "timeout" : "stale";
}

/** Resolve how the current process should launch a sibling `daemon serve` process. */
export function resolveDaemonLaunchCommand(
  argv = process.argv,
  execPath = process.execPath,
): DaemonLaunchCommand {
  const current = resolveCurrentHunkCommand(argv, execPath);
  return { command: current.command, args: [...current.args, "daemon", "serve"] };
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

export interface SessionBrokerHealth {
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

/** Parse the minimal or legacy-rich health response without trusting cross-process JSON. */
export function parseSessionBrokerHealth(value: unknown): SessionBrokerHealth | null {
  try {
    const record = parseExactBrokerRecord(
      value,
      ["ok"] as const,
      [
        "pid",
        "sessions",
        "pendingCommands",
        "startedAt",
        "uptimeMs",
        "sessionApi",
        "sessionCapabilities",
        "sessionSocket",
        "staleSessionTtlMs",
        "paths",
      ] as const,
    );
    if (record.ok !== true) return null;
    const parsed: SessionBrokerHealth = { ok: true };
    for (const key of [
      "pid",
      "sessions",
      "pendingCommands",
      "uptimeMs",
      "staleSessionTtlMs",
    ] as const) {
      if (record[key] !== undefined) parsed[key] = parseBrokerSafeInteger(record[key]);
    }
    for (const key of [
      "startedAt",
      "sessionApi",
      "sessionCapabilities",
      "sessionSocket",
    ] as const) {
      if (record[key] !== undefined) parsed[key] = parseBrokerString(record[key]);
    }
    // Generic rich health used to carry a paths object. It is accepted only as one exact bounded
    // compatibility shape and intentionally not projected into caller authority.
    if (record.paths !== undefined) {
      const paths = parseExactBrokerRecord(
        record.paths,
        ["health", "socket"] as const,
        ["api", "capabilities"] as const,
      );
      for (const path of Object.values(paths)) parseBrokerString(path);
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Read a bounded exact metadata fingerprint as a reconnect hint, never process authority. */
export function readSessionBrokerLaunchFingerprint(
  config: Pick<ResolvedSessionBrokerConfig, "host" | "port"> = resolveSessionBrokerConfig(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const { metadataPath } = resolveSessionBrokerRuntimePaths(config, env);
  try {
    const stat = statSync(metadataPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_DAEMON_LAUNCH_METADATA_BYTES)
      return null;
    const bytes = readFileSync(metadataPath);
    if (bytes.byteLength !== stat.size || bytes.byteLength > MAX_DAEMON_LAUNCH_METADATA_BYTES) {
      return null;
    }
    const metadata = parseSessionBrokerLaunchMetadata(JSON.parse(bytes.toString("utf8")));
    return metadata ? JSON.stringify(metadata) : null;
  } catch {
    return null;
  }
}

/** Read the daemon's health payload when one is reachable on the configured loopback port. */
export async function readSessionBrokerHealth(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
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

    return parseSessionBrokerHealth(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
  lifecycleClock = createNativeSessionBrokerLifecycleClock(),
  isCommitAuthorized = () => true,
  isHealthy = (resolvedConfig) => isSessionBrokerHealthy(resolvedConfig),
  isPortReachable = isLoopbackPortReachable,
  launchDaemon = launchSessionBrokerDaemon,
}: EnsureSessionBrokerAvailableOptions = {}) {
  if (!isCommitAuthorized()) return;
  const paths = resolveSessionBrokerRuntimePaths(config, env);
  cleanStaleDaemonMetadata(paths);

  const initialHealth = await settleForeignWork(() => isHealthy(config), isCommitAuthorized);
  if (!initialHealth.current || initialHealth.value) return;

  const deadline = lifecycleClock.now() + timeoutMs;

  while (isCommitAuthorized() && lifecycleClock.now() < deadline) {
    const lock = tryAcquireDaemonLaunchLock({
      config,
      env,
      staleAfterMs: lockStaleMs,
      lifecycleClock,
    });

    if (lock) {
      try {
        if (!isCommitAuthorized()) return;
        cleanStaleDaemonMetadata(paths);
        const protectedHealth = await settleForeignWork(
          () => isHealthy(config),
          isCommitAuthorized,
        );
        if (!protectedHealth.current || protectedHealth.value) return;

        if (!isCommitAuthorized()) return;
        const launchCommand = resolveDaemonLaunchCommand(argv, execPath);
        const launched = settleForeignCall(
          () => launchDaemon({ cwd, env, argv, execPath }),
          isCommitAuthorized,
        );
        // A callback may have already spawned a detached child before revoking authority. That
        // process cannot be recalled; fencing suppresses only metadata and later lifecycle commits.
        if (!launched.current) return;
        writeDaemonLaunchMetadata(paths, {
          pid: launched.value.pid ?? 0,
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
          lifecycleClock,
          isHealthy,
          isCommitAuthorized,
        });
        if (ready === "ready" || ready === "stale") return;
      } finally {
        // Lock ownership is synchronous and must be released even when foreign work settles stale.
        lock.release();
      }
    }

    if (!isCommitAuthorized()) return;
    const remainingMs = deadline - lifecycleClock.now();
    if (remainingMs <= 0) break;

    const ready = await waitForDaemonHealthWithCheck({
      config,
      timeoutMs: Math.min(remainingMs, intervalMs),
      intervalMs,
      lifecycleClock,
      isHealthy,
      isCommitAuthorized,
    });
    if (ready === "ready" || ready === "stale") return;

    if (!isCommitAuthorized()) return;
    cleanStaleDaemonMetadata(paths);
  }

  if (!isCommitAuthorized()) return;
  const portReachable = await settleForeignWork(() => isPortReachable(config), isCommitAuthorized);
  if (!portReachable.current) return;
  if (portReachable.value) throw daemonPortConflictError(config);

  if (!isCommitAuthorized()) return;
  throw daemonStartupTimeoutError(config, timeoutMessage);
}
