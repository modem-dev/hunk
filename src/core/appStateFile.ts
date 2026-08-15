/**
 * Reads and writes the app's persisted state file (`state.json`).
 *
 * This is app state, not diff state: "hunk" here is the product, so the module is named for
 * the file it owns rather than for the diff concept its `hunkHeader` / `hunkSummary`
 * neighbours describe.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One parsed state file.
 *
 * Several unrelated features (update notices, extension trust) keep small
 * records in the same file, so every writer must merge instead of overwrite.
 */
export type AppStateRecord = Record<string, unknown>;

/** Suffix a state file is moved aside to when its contents cannot be parsed. */
const CORRUPT_STATE_SUFFIX = ".corrupt";

/** What one read of the state file found on disk. */
interface AppStateFileRead {
  record: AppStateRecord;
  /**
   * True when the file existed with content Hunk could not parse.
   *
   * Distinguishes "nothing recorded yet" from "records exist but are
   * unreadable", which is the difference between a harmless write and one that
   * destroys every trust decision the user made.
   */
  corrupt: boolean;
}

/** Read and classify the state file without deciding what to do about damage. */
function readAppStateFile(path: string): AppStateFileRead {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    // Missing or unreadable: there is nothing to lose by starting empty.
    return { record: {}, corrupt: false };
  }

  if (contents.trim().length === 0) {
    return { record: {}, corrupt: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { record: {}, corrupt: true };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { record: {}, corrupt: true };
  }

  return { record: parsed as AppStateRecord, corrupt: false };
}

/** Read the persisted state record, treating missing or malformed files as empty. */
export function readAppStateRecord(path: string): AppStateRecord {
  return readAppStateFile(path).record;
}

/**
 * Write the persisted state record with owner-only permissions.
 *
 * The record is staged in a sibling temp file and renamed into place, so a
 * crash or a concurrent reader never observes a half-written file: readers see
 * either the old state or the new one. The temp file is a sibling so the rename
 * stays within one filesystem, which is what makes it atomic.
 */
export function writeAppStateRecord(path: string, record: AppStateRecord) {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = JSON.stringify(record, null, 2);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });

  try {
    renameSync(tempPath, path);
  } catch {
    // Windows can refuse a rename over a file another process still holds open.
    // Retry once with the target removed, then fall back to writing in place so
    // a state update is never silently dropped on that platform.
    try {
      rmSync(path, { force: true });
      renameSync(tempPath, path);
    } catch {
      writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
      rmSync(tempPath, { force: true });
    }
  }
}

/**
 * Move an unparseable state file aside so a fresh one can be written.
 *
 * Starting over is the safer of the two options: refusing to write would leave
 * trust decisions unrecordable until the user hand-repairs a file they never
 * knew existed, while a fresh file only costs them re-answering prompts —
 * unknown trust prompts rather than silently running anything. The damaged
 * bytes are preserved next to the state file so nothing is destroyed outright.
 */
function quarantineCorruptStateFile(path: string) {
  try {
    renameSync(path, `${path}${CORRUPT_STATE_SUFFIX}`);
  } catch {
    // Best effort: if the file cannot be moved aside, the write below still has
    // to succeed, because the alternative is a feature that can never persist.
  }
}

/**
 * Merge one patch into the persisted state record so unrelated keys survive the write.
 *
 * Read-modify-write is not locked across processes: two Hunk sessions updating
 * different keys at the same instant can still have one update win, because
 * this reads, merges, and renames without holding the file. That window is
 * small and the cost is one lost record, so it is accepted rather than paid for
 * with a lock file that has to be reaped after crashes.
 */
export function updateAppStateRecord(path: string, patch: AppStateRecord) {
  const { record, corrupt } = readAppStateFile(path);
  if (corrupt) {
    quarantineCorruptStateFile(path);
  }

  const next = { ...record, ...patch };
  writeAppStateRecord(path, next);
  return next;
}
