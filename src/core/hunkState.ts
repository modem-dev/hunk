import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Single read/write seam for the persisted Hunk state file (`state.json`).
 *
 * Several unrelated features (update notices, extension trust) keep small
 * records in the same file, so every writer must merge instead of overwrite.
 */
export type HunkStateRecord = Record<string, unknown>;

/** Read the persisted state record, treating missing or malformed files as empty. */
export function readHunkStateRecord(path: string): HunkStateRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    return parsed as HunkStateRecord;
  } catch {
    return {};
  }
}

/** Write the persisted state record with owner-only permissions. */
export function writeHunkStateRecord(path: string, record: HunkStateRecord) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Merge one patch into the persisted state record so unrelated keys survive the write. */
export function updateHunkStateRecord(path: string, patch: HunkStateRecord) {
  const next = { ...readHunkStateRecord(path), ...patch };
  writeHunkStateRecord(path, next);
  return next;
}
