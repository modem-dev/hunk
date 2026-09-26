import { describe, expect, test } from "bun:test";
import {
  HUNK_DAEMON_REGISTRATION_REJECTED_MESSAGE,
  HUNK_DAEMON_UPGRADE_WAIT_MESSAGE,
} from "./capabilities";
import {
  HUNK_DAEMON_CLIENT_NEWER_MESSAGE,
  HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
  compareDaemonBuild,
  daemonSkewNotice,
} from "./daemonSkew";

const client = { daemonVersion: 15, appVersion: "0.22.0" };

/** Builds an admin response with independently chosen package and compatibility versions. */
function createTestStatusProbe(daemonVersion: number, appVersion: string) {
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

  test("names the remedy without versions when the daemon is older", () => {
    expect(daemonSkewNotice(createTestStatusProbe(12, "0.21.1"), client)).toEqual({
      direction: "client-newer",
      notice: "Session daemon is an older Hunk build. Run `hunk daemon restart`.",
    });
  });

  test("keeps the same wording when package versions match but revisions differ", () => {
    expect(daemonSkewNotice(createTestStatusProbe(14, "0.22.0"), client).notice).toBe(
      HUNK_DAEMON_CLIENT_NEWER_MESSAGE,
    );
    expect(daemonSkewNotice(createTestStatusProbe(16, "0.22.0"), client).notice).toBe(
      HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
    );
  });

  test.each([
    [
      HUNK_DAEMON_UPGRADE_WAIT_MESSAGE,
      "Session daemon is a different Hunk build. Run `hunk daemon restart`.",
    ],
    [
      HUNK_DAEMON_CLIENT_NEWER_MESSAGE,
      "Session daemon is an older Hunk build. Run `hunk daemon restart`.",
    ],
    [
      HUNK_DAEMON_CLIENT_OLDER_MESSAGE,
      "Session daemon is newer; relaunch this window (notes are lost).",
    ],
    [
      HUNK_DAEMON_REGISTRATION_REJECTED_MESSAGE,
      "Session daemon rejected this window. Run `hunk daemon restart`.",
    ],
  ] as const)(
    "fits the complete sticky notice into an 80-column status line: %s",
    (notice, expected) => {
      expect(notice).toBe(expected);
      expect(notice.length).toBeLessThanOrEqual(78);
    },
  );

  test("tells an older window to relaunch", () => {
    expect(daemonSkewNotice(createTestStatusProbe(16, "0.23.0"), client)).toEqual({
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
    expect(daemonSkewNotice(createTestStatusProbe(15, "0.22.0"), client).notice).toBe(
      HUNK_DAEMON_UPGRADE_WAIT_MESSAGE,
    );
  });
});
