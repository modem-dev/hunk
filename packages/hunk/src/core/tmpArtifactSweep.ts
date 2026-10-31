// Interim mitigation for Bun single-file executables leaking their extracted
// native libraries into the OS temp directory on every launch (oven-sh/bun#30962).
// Each run drops a hidden `.{16hex}-{8hex}.(so|dylib|dll)` file that is never
// reused, so high-frequency invocations can fill a tmpfs. This best-effort
// startup sweep removes stale copies until Bun's own extraction dedupe fix
// (oven-sh/bun#29587) ships in a hunk release, at which point this module can be
// deleted outright.

import { lstat, readdir, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DISABLE_TMP_SWEEP_ENV = "HUNK_DISABLE_TMP_SWEEP";
const SWEEP_STAMP_BASENAME = ".hunk-tmp-sweep-stamp";
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ARTIFACT_PATTERN = /^\.[0-9a-f]{16}-[0-9a-f]{8}\.(so|dylib|dll)$/;

export interface TmpArtifactSweepDeps {
  env?: NodeJS.ProcessEnv;
  tmpdirImpl?: () => string;
  now?: () => number;
  maxAgeMs?: number;
  sweepIntervalMs?: number;
  getuid?: () => number | undefined;
}

/** Resolve the current process uid, or undefined on platforms without one (Windows). */
function resolveProcessUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Refresh the stamp's modification time to the sweep clock. */
async function stampNow(stampPath: string, nowMs: number): Promise<void> {
  const seconds = nowMs / 1000;
  await utimes(stampPath, seconds, seconds);
}

/**
 * Rate-limit and claim the sweep, returning whether the caller may proceed.
 *
 * The stamp must be a regular file owned by the current user; anything else
 * (symlink, directory, foreign owner) aborts the sweep so a hostile shared temp
 * directory cannot redirect the truncate. Claiming happens before the readdir
 * (claim-first) so concurrent starts do not all scan at once.
 */
async function claimSweep(
  stampPath: string,
  nowMs: number,
  intervalMs: number,
  uid: number | undefined,
): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    stats = await lstat(stampPath);
  } catch {
    // Most likely ENOENT: fall through to the exclusive-create path below.
    stats = undefined;
  }

  if (stats) {
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid)) {
      return false;
    }

    if (nowMs - stats.mtimeMs < intervalMs) {
      return false;
    }

    try {
      await writeFile(stampPath, "");
      await stampNow(stampPath, nowMs);
      return true;
    } catch {
      return false;
    }
  }

  try {
    // Exclusive create: if another start wins the race, treat the sweep as claimed.
    await writeFile(stampPath, "", { flag: "wx" });
    await stampNow(stampPath, nowMs);
    return true;
  } catch {
    return false;
  }
}

/** Remove one directory entry when it is a stale, same-owner Bun artifact. */
async function maybeRemoveArtifact(
  dir: string,
  name: string,
  cutoffMs: number,
  uid: number | undefined,
): Promise<void> {
  if (!ARTIFACT_PATTERN.test(name)) {
    return;
  }

  const fullPath = join(dir, name);
  try {
    const stats = await lstat(fullPath);
    if (!stats.isFile()) {
      return;
    }

    if (uid !== undefined && stats.uid !== uid) {
      return;
    }

    if (stats.mtimeMs > cutoffMs) {
      return;
    }

    await unlink(fullPath);
  } catch {
    // Best-effort: a locked, vanished, or otherwise unremovable artifact is skipped.
  }
}

/** Remove stale Bun-extracted native artifacts from the OS temp directory, best-effort. */
export async function sweepStaleTmpArtifacts(deps: TmpArtifactSweepDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (env[DISABLE_TMP_SWEEP_ENV] === "1") {
    return;
  }

  const tmpdirImpl = deps.tmpdirImpl ?? tmpdir;
  const now = deps.now ?? Date.now;
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const getuid = deps.getuid ?? resolveProcessUid;

  try {
    const dir = tmpdirImpl();
    const stampPath = join(dir, SWEEP_STAMP_BASENAME);
    const nowMs = now();
    const uid = getuid();

    if (!(await claimSweep(stampPath, nowMs, sweepIntervalMs, uid))) {
      return;
    }

    const cutoffMs = nowMs - maxAgeMs;
    const entries = await readdir(dir);
    await Promise.all(entries.map((name) => maybeRemoveArtifact(dir, name, cutoffMs, uid)));
  } catch {
    // Never surface temp-directory access errors to the caller.
  }
}
