import {
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "../broker/brokerConfig";
import { HUNK_SESSION_CAPABILITIES_PATH, type SessionDaemonCapabilities } from "../protocol";
import { parseSessionDaemonCapabilities } from "../protocolSchemas";
import { HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS, requestSessionDaemonHttp } from "./daemonHttp";

export const HUNK_DAEMON_UPGRADE_WAIT_MESSAGE =
  "An older or incompatible Hunk session daemon is running. Close older Hunk windows; this window will reconnect automatically.";

/**
 * Read the live daemon's advertised compatibility, returning null when the daemon is too old for
 * this Hunk build even if it still answers the same HTTP action list.
 */
export async function readHunkSessionDaemonCapabilities(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
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

      return parseSessionDaemonCapabilities(capabilities);
    },
  });
}
