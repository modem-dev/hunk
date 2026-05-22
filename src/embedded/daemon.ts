import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ensureSessionBrokerAvailable } from "../session-broker/brokerLauncher";
import type { EnsureSessionBrokerAdapter } from "../session-broker/brokerClient";

const require = createRequire(import.meta.url);
const JAVASCRIPT_ENTRYPOINT_PATTERN = /\.(?:[cm]?js|tsx?)$/;

export interface EmbeddedSessionBrokerAvailabilityOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  ensureAvailable?: typeof ensureSessionBrokerAvailable;
  hunkCliPath?: string;
  runtimePath?: string;
  timeoutMs?: number;
}

/** Create the embedded broker availability adapter used by embedded Hunk sessions. */
export function createEmbeddedSessionBrokerAvailability({
  cwd,
  env = process.env,
  ensureAvailable = ensureSessionBrokerAvailable,
  hunkCliPath = join(dirname(require.resolve("hunkdiff/package.json")), "bin", "hunk.cjs"),
  runtimePath = process.execPath,
  timeoutMs,
}: EmbeddedSessionBrokerAvailabilityOptions): EnsureSessionBrokerAdapter {
  return (config) => {
    // The published package bin is a JS wrapper, so launch it through the active runtime instead
    // of spawning the script path directly. Direct executable overrides still run as-is.
    const scriptEntrypoint = JAVASCRIPT_ENTRYPOINT_PATTERN.test(hunkCliPath);
    return ensureAvailable({
      argv: scriptEntrypoint ? [runtimePath, hunkCliPath] : [hunkCliPath],
      config,
      cwd,
      env,
      execPath: scriptEntrypoint ? runtimePath : hunkCliPath,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  };
}
