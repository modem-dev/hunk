import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  ensureSessionBrokerAvailable,
  type EnsureSessionBrokerAvailableOptions,
} from "../session-broker/brokerLauncher";
import type { ResolvedSessionBrokerConfig } from "../session-broker/brokerConfig";
import type { EnsureSessionBrokerAdapter } from "../session-broker/brokerClient";

const require = createRequire(import.meta.url);

type EmbeddedEnsureSessionBroker = typeof ensureSessionBrokerAvailable;

export interface EmbeddedSessionBrokerAvailabilityOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  ensureAvailable?: EmbeddedEnsureSessionBroker;
  hunkCliPath?: string;
  timeoutMs?: number;
}

/** Create the embedded broker availability adapter used by embedded Hunk sessions. */
export function createEmbeddedSessionBrokerAvailability({
  cwd,
  env = process.env,
  ensureAvailable = ensureSessionBrokerAvailable,
  hunkCliPath = join(dirname(require.resolve("hunkdiff/package.json")), "bin", "hunk.cjs"),
  timeoutMs,
}: EmbeddedSessionBrokerAvailabilityOptions): EnsureSessionBrokerAdapter {
  return (config: ResolvedSessionBrokerConfig) => {
    const options: EnsureSessionBrokerAvailableOptions = {
      argv: [hunkCliPath],
      config,
      cwd,
      env,
      execPath: hunkCliPath,
    };

    if (timeoutMs !== undefined) {
      options.timeoutMs = timeoutMs;
    }

    return ensureAvailable(options);
  };
}
