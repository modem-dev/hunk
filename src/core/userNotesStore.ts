/**
 * Disk persistence for human-authored review notes ("c" notes).
 *
 * Notes are mirrored to the JSON sidecar at the caller-supplied `--store-notes`
 * path so they survive closing the TUI and can be read back by an AI agent
 * directly off disk. Every disk operation is best-effort: a read failure yields
 * an empty map and a write failure is swallowed, so persistence never crashes
 * the review UI. Set `HUNK_DEBUG=1` to surface swallowed errors on stderr.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UserReviewNote } from "../ui/hooks/useReviewController";

export type UserNotesMap = Record<string, UserReviewNote[]>;

/** Walk up from a path to the closest ancestor directory that already exists. */
function nearestExistingDir(path: string): string {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) {
    dir = dirname(dir);
  }
  return dir;
}

/**
 * Best-effort startup heads-up: return a warning when the sidecar at `path`
 * cannot be written, else undefined. Existence is fine — only un-writability
 * warns. An existing sidecar must itself be writable; a missing one needs its
 * nearest existing ancestor writable so `mkdir -p` can create the rest. This is
 * a UX signal only; the write path stays fault-tolerant regardless.
 */
export function userNotesWriteWarning(path: string): string | undefined {
  const target = existsSync(path) ? path : nearestExistingDir(path);
  try {
    accessSync(target, constants.W_OK);
    return undefined;
  } catch {
    return `hunk: cannot write review notes to ${path}; notes from this session will not be saved.`;
  }
}

/** Emit a swallowed-error diagnostic only when the user opted into debug output. */
function debugUserNotesError(action: string, path: string, error: unknown): void {
  if (process.env.HUNK_DEBUG === "1") {
    process.stderr.write(`hunk: failed to ${action} user notes at ${path}: ${String(error)}\n`);
  }
}

/** Return whether one parsed value is an array of plausible user notes. */
function isUserNoteArray(value: unknown): value is UserReviewNote[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { summary?: unknown }).summary === "string",
    )
  );
}

/** Read persisted human notes, tolerating a missing or malformed sidecar file. */
export function readUserNotes(path: string): UserNotesMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      debugUserNotesError("read", path, error);
    }
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const map: UserNotesMap = {};
  for (const [fileId, notes] of Object.entries(parsed as Record<string, unknown>)) {
    if (isUserNoteArray(notes)) {
      map[fileId] = notes;
    }
  }
  return map;
}

/** Persist human notes to the caller-supplied sidecar path, creating parent dirs. */
export function writeUserNotes(path: string, map: UserNotesMap): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(map, null, 2), { encoding: "utf8" });
  } catch (error) {
    // Best-effort: a write failure must never crash the review UI.
    debugUserNotesError("write", path, error);
  }
}
