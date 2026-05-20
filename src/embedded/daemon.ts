import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  ensureSessionBrokerAvailable,
  type EnsureSessionBrokerAvailableOptions,
} from "../session-broker/brokerLauncher";
import type { ResolvedSessionBrokerConfig } from "../session-broker/brokerConfig";
import type { EnsureSessionBrokerAdapter } from "../session-broker/brokerClient";

const require = createRequire(import.meta.url);
const JAVASCRIPT_ENTRYPOINT_PATTERN = /\.(?:[cm]?js|tsx?)$/;

type EmbeddedEnsureSessionBroker = typeof ensureSessionBrokerAvailable;

export interface EmbeddedSessionBrokerAvailabilityOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  ensureAvailable?: EmbeddedEnsureSessionBroker;
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
  return (config: ResolvedSessionBrokerConfig) => {
    // The published package bin is a JS wrapper, so launch it through the active runtime instead
    // of spawning the script path directly. Direct executable overrides still run as-is.
    const scriptEntrypoint = JAVASCRIPT_ENTRYPOINT_PATTERN.test(hunkCliPath);
    const options: EnsureSessionBrokerAvailableOptions = {
      argv: scriptEntrypoint ? [runtimePath, hunkCliPath] : [hunkCliPath],
      config,
      cwd,
      env,
      execPath: scriptEntrypoint ? runtimePath : hunkCliPath,
    };

    if (timeoutMs !== undefined) {
      options.timeoutMs = timeoutMs;
    }

    return ensureAvailable(options);
  };
}
