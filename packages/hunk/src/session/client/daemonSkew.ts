import type { SessionBrokerAdminStatusV1 } from "@hunk/session-broker";
import { resolveCliVersion } from "../../core/run/version";
import { HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import {
  HUNK_DAEMON_CLIENT_NEWER_MESSAGE,
  HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
  HUNK_DAEMON_UPGRADE_WAIT_MESSAGE,
} from "./daemonMessages";
import type { HunkDaemonAdminProbe } from "./daemonAdmin";

export {
  HUNK_DAEMON_CLIENT_NEWER_MESSAGE,
  HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
} from "./daemonMessages";

/**
 * Turns a daemon's admin status into the direction of a version skew and the notice a window or
 * CLI should show for it.
 *
 * "Client newer" is recoverable in place: `hunk daemon restart` spawns a daemon from the newer
 * build and the window reconnects. "Client older" is not: the daemon will never accept this
 * window, and a newer daemon replacing it does not help either, so the window must be relaunched.
 */
export type DaemonSkewDirection = "client-newer" | "client-older" | "matched";

export interface DaemonBuild {
  daemonVersion: number;
  appVersion: string;
}

/** The build this process speaks. */
export function currentDaemonBuild(): DaemonBuild {
  return { daemonVersion: HUNK_SESSION_DAEMON_VERSION, appVersion: resolveCliVersion() };
}

/** Compare a daemon's revision to this build's. */
export function compareDaemonBuild(
  daemonVersion: number,
  clientVersion = HUNK_SESSION_DAEMON_VERSION,
): DaemonSkewDirection {
  if (daemonVersion === clientVersion) return "matched";
  return daemonVersion < clientVersion ? "client-newer" : "client-older";
}

/**
 * Resolve the notice for a refused hello from what the admin scope reported. A daemon that does
 * not speak the admin scope, or none at all, keeps the generic wait message.
 */
export function daemonSkewNotice(
  probe: HunkDaemonAdminProbe,
  client = currentDaemonBuild(),
): { direction: DaemonSkewDirection | "unknown"; notice: string } {
  if (probe.kind !== "status") {
    return { direction: "unknown", notice: HUNK_DAEMON_UPGRADE_WAIT_MESSAGE };
  }
  const direction = compareDaemonBuild(probe.status.daemonVersion, client.daemonVersion);
  switch (direction) {
    case "client-newer":
      return { direction, notice: HUNK_DAEMON_CLIENT_NEWER_MESSAGE };
    case "client-older":
      return { direction, notice: HUNK_DAEMON_CLIENT_OLDER_MESSAGE };
    case "matched":
      // The hello was refused for a reason other than the revision; say what we know.
      return { direction, notice: HUNK_DAEMON_UPGRADE_WAIT_MESSAGE };
  }
}

/** Narrow one admin status to the two build facts the notices need. */
export function daemonBuildFromStatus(status: SessionBrokerAdminStatusV1): DaemonBuild {
  return { daemonVersion: status.daemonVersion, appVersion: status.appVersion };
}
