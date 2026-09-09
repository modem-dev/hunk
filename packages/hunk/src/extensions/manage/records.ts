import { join } from "node:path";
import { readAppStateRecord, writeAppStateRecord } from "../../core/process/appStateFile";

/**
 * What `hunk extension install` remembers about one managed install.
 *
 * The record is the source of truth for which directories under the managed
 * install root Hunk owns: `list`, `update`, and `remove` operate only on
 * recorded names, so a folder the user copied in by hand is never touched.
 */
export interface ExtensionInstallRecord {
  /** The install source exactly as the user typed it. */
  source: string;
  /** URL (or local path) `git clone` was run with. */
  cloneUrl: string;
  /** Branch, tag, or commit pinned with `@ref`, if any. */
  ref?: string;
  /** Commit the install currently sits at. */
  commit: string;
  /** ISO timestamp of the first install. */
  installedAt: string;
  /** ISO timestamp of the last install or update. */
  updatedAt: string;
}

export type ExtensionInstallRecordMap = Record<string, ExtensionInstallRecord>;

/** File inside the managed install root that holds the records. */
const RECORDS_FILE_NAME = "records.json";

/** Resolve the records file for one managed install root. */
export function resolveInstallRecordsPath(installedRoot: string) {
  return join(installedRoot, RECORDS_FILE_NAME);
}

/** Accept one stored record only when every required field survived the disk. */
function normalizeRecord(value: unknown): ExtensionInstallRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.source !== "string" ||
    typeof record.cloneUrl !== "string" ||
    typeof record.commit !== "string" ||
    typeof record.installedAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return undefined;
  }

  return {
    source: record.source,
    cloneUrl: record.cloneUrl,
    ...(typeof record.ref === "string" ? { ref: record.ref } : {}),
    commit: record.commit,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  };
}

/** Read every install record, treating a missing or damaged file as empty. */
export function readInstallRecords(installedRoot: string): ExtensionInstallRecordMap {
  const stored = readAppStateRecord(resolveInstallRecordsPath(installedRoot)).installs;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return {};
  }

  const records: ExtensionInstallRecordMap = {};
  for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
    const normalized = normalizeRecord(value);
    if (normalized) {
      records[name] = normalized;
    }
  }

  return records;
}

/** Persist the full install record map. */
export function writeInstallRecords(installedRoot: string, records: ExtensionInstallRecordMap) {
  writeAppStateRecord(resolveInstallRecordsPath(installedRoot), { installs: records });
}
