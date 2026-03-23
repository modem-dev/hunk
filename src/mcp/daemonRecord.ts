import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveHunkMcpConfig, type ResolvedHunkMcpConfig } from "./config";

export interface HunkDaemonRecord {
  pid: number;
  startedAt: string;
  instanceId: string;
}

function sanitizeHost(host: string) {
  return host.replace(/[^a-z0-9_.:-]+/gi, "_");
}

function runtimeUserSuffix(env: NodeJS.ProcessEnv = process.env) {
  if (typeof process.getuid === "function") {
    return String(process.getuid());
  }

  return env.USER?.trim() || env.USERNAME?.trim() || "shared";
}

function resolveDaemonRuntimeDir(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.XDG_RUNTIME_DIR?.trim();
  if (configured) {
    return join(configured, "hunk");
  }

  return join(tmpdir(), `hunk-${runtimeUserSuffix(env)}`);
}

/** Resolve the per-user daemon record path for one host/port pair. */
export function resolveDaemonRecordPath(
  config: ResolvedHunkMcpConfig = resolveHunkMcpConfig(),
  env: NodeJS.ProcessEnv = process.env,
) {
  return join(
    resolveDaemonRuntimeDir(env),
    `daemon-${sanitizeHost(config.host)}-${config.port}.json`,
  );
}

function isDaemonRecord(value: unknown): value is HunkDaemonRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.instanceId === "string" &&
    candidate.instanceId.length > 0
  );
}

/** Read one previously persisted daemon record, if it looks valid. */
export function readDaemonRecord(
  config: ResolvedHunkMcpConfig = resolveHunkMcpConfig(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = resolveDaemonRecordPath(config, env);
  if (!fs.existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    return isDaemonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the currently running daemon's identity so sibling Hunk commands can verify it later. */
export function writeDaemonRecord(
  record: HunkDaemonRecord,
  config: ResolvedHunkMcpConfig = resolveHunkMcpConfig(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = resolveDaemonRecordPath(config, env);
  const directory = dirname(path);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tempPath, path);
}

/** Remove the persisted daemon identity if it still belongs to the same daemon instance. */
export function clearDaemonRecord(
  expected: Pick<HunkDaemonRecord, "pid" | "instanceId">,
  config: ResolvedHunkMcpConfig = resolveHunkMcpConfig(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = resolveDaemonRecordPath(config, env);
  const current = readDaemonRecord(config, env);
  if (!current) {
    return;
  }

  if (current.pid !== expected.pid || current.instanceId !== expected.instanceId) {
    return;
  }

  try {
    fs.unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}
