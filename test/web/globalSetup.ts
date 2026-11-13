/**
 * Gives one browser-test run its own directory and stops whatever the run left running.
 *
 * The directory is handed to every worker through the environment; the harness creates each
 * test's runtime and config directories inside it and records each process it spawns there
 * (`testProcesses.ts`). The returned teardown runs after every worker has ended, a crashed one
 * included, and stops only processes recorded under this run's directory.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTestRun, TEST_RUN_DIR_ENV } from "./testProcesses";

/** Make the run's directory; return the teardown that sweeps it. */
export default async function globalSetup() {
  const runDir = mkdtempSync(join(tmpdir(), "hunk-web-run-"));
  process.env[TEST_RUN_DIR_ENV] = runDir;
  return async () => {
    await sweepTestRun(runDir);
  };
}
