import {
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "../session-broker/brokerConfig";
import {
  readSessionBrokerRuntimeMetadata,
  type SessionBrokerDaemonIdentity,
} from "../session-broker/brokerLauncher";
import {
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_CAPABILITIES_PATH,
  HUNK_SESSION_DAEMON_VERSION,
  type SessionDaemonCapabilities,
} from "./protocol";
import { HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS, requestSessionDaemonHttp } from "./daemonHttp";

export const HUNK_DAEMON_UPGRADE_RESTART_NOTICE =
  "[hunk:session] Restarting stale session daemon after upgrade.";

/** Tell the user that Hunk is refreshing an old daemon left running across an upgrade. */
export function reportHunkDaemonUpgradeRestart(log: (message: string) => void = console.error) {
  log(HUNK_DAEMON_UPGRADE_RESTART_NOTICE);
}

export async function readHunkSessionDaemonCapabilitiesForIdentity(
  config: ResolvedSessionBrokerConfig,
  identity: SessionBrokerDaemonIdentity,
  timeoutMs = HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS,
): Promise<SessionDaemonCapabilities | null> {
  return requestSessionDaemonHttp({
    config,
    path: HUNK_SESSION_CAPABILITIES_PATH,
    operation: "report capabilities",
    timeoutMs,
    parse: async (response) => {
      if (response.status === 404 || response.status === 410) {
        return null;
      }

      if (!response.ok) {
        return null;
      }

      let capabilities: unknown;
      try {
        capabilities = await response.json();
      } catch {
        return null;
      }

      if (
        !capabilities ||
        typeof capabilities !== "object" ||
        (capabilities as { version?: unknown }).version !== HUNK_SESSION_API_VERSION ||
        (capabilities as { daemonVersion?: unknown }).daemonVersion !==
          HUNK_SESSION_DAEMON_VERSION ||
        (capabilities as { nonce?: unknown }).nonce !== identity.nonce ||
        !Array.isArray((capabilities as { actions?: unknown }).actions)
      ) {
        return null;
      }

      return capabilities as SessionDaemonCapabilities;
    },
  });
}

/**
 * Read the live daemon's advertised compatibility, returning null when the daemon is too old for
 * this Hunk build even if it still answers the same HTTP action list.
 */
export async function readHunkSessionDaemonCapabilities(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
  timeoutMs = HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS,
): Promise<SessionDaemonCapabilities | null> {
  const metadata = readSessionBrokerRuntimeMetadata(config);
  if (!metadata) {
    return null;
  }

  return readHunkSessionDaemonCapabilitiesForIdentity(config, metadata, timeoutMs);
}
