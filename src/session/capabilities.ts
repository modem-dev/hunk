import { resolveHunkMcpConfig, type ResolvedHunkMcpConfig } from "../mcp/config";
import {
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_CAPABILITIES_PATH,
  type SessionDaemonCapabilities,
} from "./protocol";

export const HUNK_DAEMON_UPGRADE_RESTART_NOTICE =
  "[hunk:mcp] Restarting stale session daemon after upgrade.";

/** Tell the user that Hunk is refreshing an old daemon left running across an upgrade. */
export function reportHunkDaemonUpgradeRestart(log: (message: string) => void = console.error) {
  log(HUNK_DAEMON_UPGRADE_RESTART_NOTICE);
}

/** Read the live daemon's session API capabilities, returning null for incompatible daemons. */
export async function readHunkSessionDaemonCapabilities(
  config: ResolvedHunkMcpConfig = resolveHunkMcpConfig(),
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
    !Array.isArray((capabilities as { actions?: unknown }).actions)
  ) {
    return null;
  }

  return capabilities as SessionDaemonCapabilities;
}
