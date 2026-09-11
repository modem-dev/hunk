import type { SessionBrokerAdminStatusV1 } from "@hunk/session-broker";
import { resolveCliVersion } from "../../core/run/version";
import { HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import { HUNK_DAEMON_UPGRADE_WAIT_MESSAGE } from "./capabilities";
import type { HunkDaemonAdminProbe } from "./daemonAdmin";

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

/** Notice for a window whose build predates the daemon; nothing but a relaunch reconnects it. */
export const HUNK_DAEMON_CLIENT_OLDER_MESSAGE =
  "This window is on an older Hunk build than the session daemon. Relaunch it to reconnect (notes in this window will be lost).";

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

/** Render one build as its app version, adding the revision when versions alone would not differ. */
function describeBuild(build: DaemonBuild, other: DaemonBuild) {
  return build.appVersion === other.appVersion
    ? `${build.appVersion} (revision ${build.daemonVersion})`
    : build.appVersion;
}

/** Notice for a window refused by a daemon from an older build. */
export function daemonOlderThanClientNotice(daemon: DaemonBuild, client = currentDaemonBuild()) {
  return (
    `Not connected to the session daemon (daemon build ${describeBuild(daemon, client)}, ` +
    `this window ${describeBuild(client, daemon)}). Run \`hunk daemon restart\`.`
  );
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
      return { direction, notice: daemonOlderThanClientNotice(probe.status, client) };
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
