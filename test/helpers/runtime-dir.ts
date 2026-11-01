import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTestDirectory } from "./filesystem";

export interface TestRuntimeDir {
  /** Private directory to pass as XDG_RUNTIME_DIR. */
  readonly path: string;
  /** Remove the directory after transient Windows process handles are released. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Create a private XDG_RUNTIME_DIR so daemon launch metadata, locks, and session credentials a
 * test writes never land in the developer's real runtime dir.
 *
 * Callers create the dir at module scope, so pair it with `afterAll(cleanup)`; Bun's test runner
 * does not emit `process.on("exit")`, so the helper cannot sweep after itself.
 */
export function createTestRuntimeDir(prefix = "hunk-test-runtime-"): TestRuntimeDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => removeTestDirectory(path) };
}
