import { describe, expect, test } from "bun:test";
import { HUNK_DAEMON_UPGRADE_WAIT_MESSAGE } from "./capabilities";
import {
  HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
  compareDaemonBuild,
  daemonOlderThanClientNotice,
  daemonSkewNotice,
} from "./daemonSkew";

const client = { daemonVersion: 15, appVersion: "0.22.0" };

function statusProbe(daemonVersion: number, appVersion: string) {
  return {
    kind: "status" as const,
    status: {
      adminScopeVersion: 1 as const,
      daemonVersion,
      appVersion,
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
      uptimeMs: 1_000,
      sessions: [],
    },
  };
}

describe("daemon skew notices", () => {
  test("compares revisions from the client's point of view", () => {
    expect(compareDaemonBuild(12, 15)).toBe("client-newer");
    expect(compareDaemonBuild(16, 15)).toBe("client-older");
    expect(compareDaemonBuild(15, 15)).toBe("matched");
  });

  test("names both builds and the restart command when the daemon is older", () => {
    expect(daemonSkewNotice(statusProbe(12, "0.21.1"), client)).toEqual({
      direction: "client-newer",
      notice:
        "Not connected to the session daemon (daemon build 0.21.1, this window 0.22.0). Run `hunk daemon restart`.",
    });
  });

  // Intent: the incident daemon reported the same package version as the client (an unreleased
  // main build), so the version alone would have read as "0.22.0 vs 0.22.0".
  test("adds the revision when both builds report the same app version", () => {
    expect(daemonOlderThanClientNotice({ daemonVersion: 14, appVersion: "0.22.0" }, client)).toBe(
      "Not connected to the session daemon (daemon build 0.22.0 (revision 14), this window 0.22.0 (revision 15)). Run `hunk daemon restart`.",
    );
  });

  test("tells an older window to relaunch", () => {
    expect(daemonSkewNotice(statusProbe(16, "0.23.0"), client)).toEqual({
      direction: "client-older",
      notice: HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
    });
  });

  test("keeps the generic wait message when the daemon predates the admin scope", () => {
    expect(daemonSkewNotice({ kind: "unsupported" }, client)).toEqual({
      direction: "unknown",
      notice: HUNK_DAEMON_UPGRADE_WAIT_MESSAGE,
    });
    expect(daemonSkewNotice({ kind: "unavailable" }, client).notice).toBe(
      HUNK_DAEMON_UPGRADE_WAIT_MESSAGE,
    );
    expect(daemonSkewNotice(statusProbe(15, "0.22.0"), client).notice).toBe(
      HUNK_DAEMON_UPGRADE_WAIT_MESSAGE,
    );
  });
});
