import { join } from "node:path";
import { isValidExtensionId } from "../extensionIds";
import { parseExtensionInstallSource } from "./source";
import { readAppStateRecord, writeAppStateRecord } from "../../core/process/appStateFile";

/**
 * What `hunk extension install` remembers about one managed install.
 *
 * The record is the source of truth for which directories under the managed
 * install root Hunk owns: `list`, `update`, and `remove` operate only on
 * recorded names, so a folder the user copied in by hand is never touched.
 */
interface ExtensionInstallRecordBase {
  /** The requested install source, independent of the currently resolved identity. */
  source: string;
  /** ISO timestamp of the first install. */
  installedAt: string;
  /** ISO timestamp of the last install or update. */
  updatedAt: string;
}

/** Remember an npm selector and its separately resolved package version. */
export interface NpmExtensionInstallRecord extends ExtensionInstallRecordBase {
  kind: "npm";
  packageName: string;
  selector?: string;
  version: string;
}

/** Remember a Git ref and commit; untagged legacy records normalize to this variant. */
export interface GitExtensionInstallRecord extends ExtensionInstallRecordBase {
  kind: "git";
  /** URL (or local path) `git clone` was run with. */
  cloneUrl: string;
  /** Branch, tag, or commit pinned with `@ref`, if any. */
  ref?: string;
  /** Commit the install currently sits at. */
  commit: string;
}

export type ExtensionInstallRecord = GitExtensionInstallRecord | NpmExtensionInstallRecord;
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
    typeof record.installedAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return undefined;
  }

  if (record.kind === "npm") {
    if (
      typeof record.packageName !== "string" ||
      typeof record.version !== "string" ||
      (record.selector !== undefined && typeof record.selector !== "string")
    ) {
      return undefined;
    }

    try {
      const source = parseExtensionInstallSource(record.source);
      if (
        source.kind !== "npm" ||
        source.packageName !== record.packageName ||
        source.selector !== record.selector
      )
        return undefined;
    } catch {
      return undefined;
    }

    return {
      kind: "npm",
      source: record.source,
      packageName: record.packageName,
      version: record.version,
      ...(typeof record.selector === "string" ? { selector: record.selector } : {}),
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    };
  }

  if (
    (record.kind !== undefined && record.kind !== "git") ||
    typeof record.cloneUrl !== "string" ||
    typeof record.commit !== "string"
  ) {
    return undefined;
  }

  return {
    kind: "git",
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
    if (normalized && isValidExtensionId(name)) {
      records[name] = normalized;
    }
  }

  return records;
}

/** Persist the full install record map. */
export function writeInstallRecords(installedRoot: string, records: ExtensionInstallRecordMap) {
  writeAppStateRecord(resolveInstallRecordsPath(installedRoot), { installs: records });
}
