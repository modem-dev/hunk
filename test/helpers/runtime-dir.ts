import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTestDirectory } from "./filesystem";

export interface TestRuntimeDir {
  /** Private directory to pass as XDG_RUNTIME_DIR. */
  readonly path: string;
  /** Environment overrides that isolate both runtime directory selectors. */
  readonly env: { HUNK_RUNTIME_DIR: undefined; XDG_RUNTIME_DIR: string };
  /** Remove the directory after transient Windows process handles are released. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Create a private XDG_RUNTIME_DIR so daemon launch metadata, locks, and session credentials a
 * test writes never land in the developer's real runtime dir. Spread `env` after the inherited
 * process environment to clear the higher-precedence HUNK_RUNTIME_DIR override.
 *
 * Callers create the dir at module scope, so pair it with `afterAll(cleanup)`; Bun's test runner
 * does not emit `process.on("exit")`, so the helper cannot sweep after itself.
 */
export function createTestRuntimeDir(prefix = "hunk-test-runtime-"): TestRuntimeDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    env: { HUNK_RUNTIME_DIR: undefined, XDG_RUNTIME_DIR: path },
    cleanup: () => removeTestDirectory(path),
  };
}
