import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseWatchRunRecord,
  type BenchmarkRevision,
  type WatchRunKind,
  type WatchRunRecord,
} from "./schema";

/** Reject path components that could make campaign artifact placement host-dependent. */
function stableComponent(value: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new Error(`Invalid ${field}: ${value}`);
  return value;
}

/** Resolve the stable raw path while retaining a failed first attempt beside its one retry. */
export function rawResultPath(options: {
  outputDir: string;
  hostId: string;
  fixtureId: string;
  revision: BenchmarkRevision;
  runKind: WatchRunKind;
  runNumber: number;
  retryAttempt?: number;
}): string {
  if (!Number.isSafeInteger(options.runNumber) || options.runNumber < 1) {
    throw new Error("runNumber must be a positive integer");
  }
  const retryAttempt = options.retryAttempt ?? 0;
  if (retryAttempt !== 0 && retryAttempt !== 1) throw new Error("retryAttempt must be zero or one");
  const filename = `run-${String(options.runNumber).padStart(2, "0")}${retryAttempt ? "-retry-1" : ""}.json`;
  return join(
    options.outputDir,
    "raw",
    stableComponent(options.hostId, "host ID"),
    stableComponent(options.fixtureId, "fixture ID"),
    options.revision,
    options.runKind,
    filename,
  );
}

/** Validate then write one measured raw record with stable JSON formatting. */
export function writeRawRecord(path: string, record: WatchRunRecord): void {
  const validated = parseWatchRunRecord(record);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
}

/** Place binary terminal diagnostics beside the corresponding raw JSON record. */
export function terminalLogPath(rawPath: string): string {
  return rawPath.replace(/\.json$/, ".terminal.bin");
}
