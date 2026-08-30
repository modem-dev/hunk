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
const MAX_DAEMON_HEALTH_RESPONSE_BYTES = 64 * 1024;

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

type SessionBrokerHealthProbeResult =
  | { kind: "healthy"; health: SessionBrokerHealth }
  | { kind: "http-status"; status: number; elapsedMs: number }
  | { kind: "invalid-json"; elapsedMs: number }
  | { kind: "invalid-response"; elapsedMs: number }
  | { kind: "response-too-large"; limitBytes: number; elapsedMs: number }
  | { kind: "timeout"; timeoutMs: number; elapsedMs: number }
  | { kind: "request-error"; message: string; elapsedMs: number };

type SessionBrokerHealthProbeFailure = Exclude<SessionBrokerHealthProbeResult, { kind: "healthy" }>;

class SessionBrokerHealthResponseTooLargeError extends Error {}
class SessionBrokerHealthInvalidJsonError extends Error {}

/** Round one failed probe duration for stable, human-readable diagnostics. */
function healthProbeElapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/** Bound one runtime-generated transport error before it reaches a terminal. */
function healthProbeErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message || error.name : String(error);
  return (
    raw
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240) || "Unknown request error"
  );
}

/** Read one health response body without allowing a foreign listener to stream unbounded data. */
async function readSessionBrokerHealthJson(response: Response) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^(?:0|[1-9][0-9]*)$/.test(declaredLength) &&
    Number(declaredLength) > MAX_DAEMON_HEALTH_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new SessionBrokerHealthResponseTooLargeError();
  }

  if (!response.body) throw new SessionBrokerHealthInvalidJsonError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DAEMON_HEALTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SessionBrokerHealthResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new SessionBrokerHealthInvalidJsonError();
  }
}

/** Describe one failed health probe for the final user-facing CLI error. */
export function describeSessionBrokerHealthProbeFailure(failure: SessionBrokerHealthProbeFailure) {
  switch (failure.kind) {
    case "http-status":
      return `returned HTTP ${failure.status} after ${failure.elapsedMs}ms`;
    case "invalid-json":
      return `returned invalid JSON after ${failure.elapsedMs}ms`;
    case "invalid-response":
      return `returned an incompatible health payload after ${failure.elapsedMs}ms`;
    case "response-too-large":
      return `exceeded ${failure.limitBytes} bytes after ${failure.elapsedMs}ms`;
    case "timeout":
      return `timed out after ${failure.timeoutMs}ms (probe elapsed ${failure.elapsedMs}ms)`;
    case "request-error":
      return `failed after ${failure.elapsedMs}ms (${failure.message})`;
  }
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

/** Probe daemon health while retaining bounded failure evidence for a terminal CLI error. */
export async function probeSessionBrokerHealth(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
  timeoutMs = 500,
): Promise<SessionBrokerHealthProbeResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutResult = new Promise<SessionBrokerHealthProbeResult>((resolveTimeout) => {
    // Keep this timer referenced: Bun 1.3.x on Windows can skip unref'ed timeout guards.
    timeout = setTimeout(() => {
      resolveTimeout({
        kind: "timeout",
        timeoutMs,
        elapsedMs: healthProbeElapsedMs(startedAt),
      });
      controller.abort();
    }, timeoutMs);
  });
  const requestResult = (async (): Promise<SessionBrokerHealthProbeResult> => {
    try {
      const response = await fetch(`${config.httpOrigin}/health`, {
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return {
          kind: "http-status",
          status: response.status,
          elapsedMs: healthProbeElapsedMs(startedAt),
        };
      }

      let payload: unknown;
      try {
        payload = await readSessionBrokerHealthJson(response);
      } catch (error) {
        if (error instanceof SessionBrokerHealthResponseTooLargeError) {
          return {
            kind: "response-too-large",
            limitBytes: MAX_DAEMON_HEALTH_RESPONSE_BYTES,
            elapsedMs: healthProbeElapsedMs(startedAt),
          };
        }
        if (error instanceof SessionBrokerHealthInvalidJsonError) {
          return { kind: "invalid-json", elapsedMs: healthProbeElapsedMs(startedAt) };
        }
        throw error;
      }

      const health = parseSessionBrokerHealth(payload);
      return health
        ? { kind: "healthy", health }
        : { kind: "invalid-response", elapsedMs: healthProbeElapsedMs(startedAt) };
    } catch (error) {
      return {
        kind: "request-error",
        message: healthProbeErrorMessage(error),
        elapsedMs: healthProbeElapsedMs(startedAt),
      };
    }
  })();

  try {
    return await Promise.race([requestResult, timeoutResult]);
  } finally {
    clearTimeout(timeout!);
    // A runtime may ignore abort; consume any later rejection after the timeout result wins.
    requestResult.catch(() => undefined);
  }
}

/** Read the daemon's health payload while preserving the nullable compatibility contract. */
export async function readSessionBrokerHealth(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
  timeoutMs = 500,
) {
  const result = await probeSessionBrokerHealth(config, timeoutMs);
  return result.kind === "healthy" ? result.health : null;
}

/** Check whether the loopback session broker already answers health probes. */
export async function isSessionBrokerHealthy(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
  timeoutMs = 500,
) {
  return (await probeSessionBrokerHealth(config, timeoutMs)).kind === "healthy";
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
