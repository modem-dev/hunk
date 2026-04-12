import {
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "../session-broker/brokerConfig";
import {
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_CAPABILITIES_PATH,
  HUNK_SESSION_DAEMON_VERSION,
  type SessionDaemonCapabilities,
} from "./protocol";

export const HUNK_DAEMON_UPGRADE_RESTART_NOTICE =
  "[hunk:session] Restarting stale session daemon after upgrade.";

/** Tell the user that Hunk is refreshing an old daemon left running across an upgrade. */
export function reportHunkDaemonUpgradeRestart(log: (message: string) => void = console.error) {
  log(HUNK_DAEMON_UPGRADE_RESTART_NOTICE);
}

/**
 * Read the live daemon's advertised compatibility, returning null when the daemon is too old for
 * this Hunk build even if it still answers the same HTTP action list.
 */
export async function readHunkSessionDaemonCapabilities(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
): Promise<SessionDaemonCapabilities | null> {
  const response = await fetch(`${config.httpOrigin}${HUNK_SESSION_CAPABILITIES_PATH}`);
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
    (capabilities as { daemonVersion?: unknown }).daemonVersion !== HUNK_SESSION_DAEMON_VERSION ||
    !Array.isArray((capabilities as { actions?: unknown }).actions)
  ) {
    return null;
  }

  return capabilities as SessionDaemonCapabilities;
}
