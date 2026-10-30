import { describe, expect, test } from "bun:test";
import type { SessionBrokerLaunchMetadata } from "../broker/brokerLauncher";
import type { HunkDaemonAdminProbe } from "../client/daemonAdmin";
import {
  formatDaemonStatusReport,
  runDaemonRestartCommand,
  runDaemonStatusCommand,
  type DaemonCommandDependencies,
} from "./daemonCommands";

const CLIENT_BUILD = { daemonVersion: 15, appVersion: "0.22.0" };

function adminStatus(daemonVersion: number, appVersion: string, sessions = 2) {
  return {
    kind: "status" as const,
    status: {
      adminScopeVersion: 1 as const,
      daemonVersion,
      appVersion,
      pid: 4242,
      startedAt: "2026-09-08T09:42:00.000Z",
      uptimeMs: 3 * 3_600_000 + 12 * 60_000,
      sessions: Array.from({ length: sessions }, (_, index) => ({
        sessionId: `session-${index + 1}-0000-0000`,
        title: `review ${index + 1}`,
        cwd: `/repo/${index + 1}`,
        pid: 100 + index,
        clientDaemonVersion: daemonVersion,
      })),
    },
  };
}

const launchMetadata: SessionBrokerLaunchMetadata = {
  pid: 777,
  host: "127.0.0.1",
  port: 47657,
  command: "/usr/local/bin/hunk",
  args: ["daemon", "serve"],
  launchedAt: "2026-09-08T09:42:00.000Z",
  launchedByPid: 1,
  launchCwd: "/repo",
};

/** A scripted daemon: which probe answers come back, in order, plus a process-table journal. */
function createFakeDaemon({
  probes,
  healthy = true,
  stopResult = "stopping" as "stopping" | "unsupported" | "unavailable",
  launch = launchMetadata as SessionBrokerLaunchMetadata | null,
  isTerminal = true,
  lockAvailable = true,
}: {
  probes: HunkDaemonAdminProbe[];
  healthy?: boolean;
  stopResult?: "stopping" | "unsupported" | "unavailable";
  launch?: SessionBrokerLaunchMetadata | null;
  isTerminal?: boolean;
  lockAvailable?: boolean;
}) {
  const journal: string[] = [];
  let health = healthy;
  let probeIndex = 0;
  const deps: DaemonCommandDependencies = {
    config: { host: "127.0.0.1", port: 47657, httpOrigin: "http://x", wsOrigin: "ws://x" },
    clientBuild: CLIENT_BUILD,
    probeAdminStatus: async () => {
      const probe = probes[Math.min(probeIndex, probes.length - 1)]!;
      probeIndex += 1;
      return probe;
    },
    requestStop: async () => {
      journal.push("stop");
      if (stopResult === "stopping") health = false;
      return stopResult;
    },
    readLaunchMetadata: () => launch,
    isHealthy: async () => health,
    acquireLaunchLock: () => {
      if (!lockAvailable) return null;
      journal.push("lock");
      return {
        release: () => {
          journal.push("unlock");
        },
      };
    },
    launchDaemon: () => {
      journal.push("launch");
      health = true;
      return { ...launchMetadata, pid: 9999 };
    },
    waitForHealth: async (expected) => {
      journal.push(`wait:${expected ? "up" : "down"}`);
      return health === expected ? "ready" : "timeout";
    },
    killProcess: (pid, signal) => {
      journal.push(`kill:${pid}:${signal}`);
      health = false;
    },
    isTerminal,
  };
  return { deps, journal };
}

function createIo(answers: boolean[] = []) {
  const out: string[] = [];
  const questions: string[] = [];
  return {
    out,
    questions,
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => out.push(`[stderr] ${text}`),
      confirm: async (question: string) => {
        questions.push(question);
        return answers.shift() ?? false;
      },
    },
  };
}

describe("hunk daemon status", () => {
  test("summarizes a matching daemon and its attached windows", async () => {
    const { deps } = createFakeDaemon({ probes: [adminStatus(15, "0.22.0")] });
    const { io, out } = createIo();

    expect(await runDaemonStatusCommand({ kind: "daemon-status", output: "text" }, io, deps)).toBe(
      0,
    );
    expect(out.join("")).toBe(
      [
        "Session daemon 0.22.0, pid 4242, up 3h 12m (started 2026-09-08T09:42:00.000Z).",
        "Attached windows (2):",
        "  session-  review 1  /repo/1",
        "  session-  review 2  /repo/2",
        "",
      ].join("\n"),
    );
  });

  // Every attached window matches the daemon; state the restart cost once, in either direction.
  test.each([
    [12, "client-newer", "a newer Hunk build"],
    [16, "client-older", "an older Hunk build"],
  ] as const)(
    "reports skew at revision %i without per-window markers",
    (revision, direction, relation) => {
      const lines = formatDaemonStatusReport({
        kind: "status",
        status: adminStatus(revision, "0.22.0").status,
        direction,
      });
      expect(lines).toEqual([
        "Session daemon 0.22.0, pid 4242, up 3h 12m (started 2026-09-08T09:42:00.000Z).",
        `This CLI is ${relation}, so the daemon refuses it.`,
        "Attached windows (2). A restart disconnects them; they must be relaunched, losing their notes.",
        "  session-  review 1  /repo/1",
        "  session-  review 2  /repo/2",
      ]);
    },
  );

  test("reports no attached windows without a restart warning", () => {
    expect(
      formatDaemonStatusReport({
        kind: "status",
        status: adminStatus(12, "0.21.1", 0).status,
        direction: "client-newer",
      }),
    ).toEqual([
      "Session daemon 0.21.1, pid 4242, up 3h 12m (started 2026-09-08T09:42:00.000Z).",
      "This CLI is a newer Hunk build, so the daemon refuses it.",
      "No windows are attached.",
    ]);
  });

  test("reports missing launch metadata without inventing a build number", () => {
    expect(formatDaemonStatusReport({ kind: "pre-admin", launch: null })).toEqual([
      "A session daemon is running, but it is from a build that predates `hunk daemon status` and cannot report itself; no launch metadata was found.",
      "This CLI is a newer Hunk build.",
    ]);
  });

  test("reports the launch metadata for a daemon that predates the admin scope", async () => {
    const { deps } = createFakeDaemon({ probes: [{ kind: "unsupported" }] });
    const { io, out } = createIo();

    await runDaemonStatusCommand({ kind: "daemon-status", output: "text" }, io, deps);
    expect(out.join("")).toBe(
      "A session daemon is running (pid 777, started 2026-09-08T09:42:00.000Z, command /usr/local/bin/hunk daemon serve), but it is from a build that predates `hunk daemon status` and cannot report itself.\nThis CLI is a newer Hunk build.\n",
    );
  });

  test("says so when no daemon is running, with exit 0", async () => {
    const { deps } = createFakeDaemon({ probes: [{ kind: "unavailable" }], healthy: false });
    const { io, out } = createIo();

    expect(await runDaemonStatusCommand({ kind: "daemon-status", output: "text" }, io, deps)).toBe(
      0,
    );
    expect(out.join("")).toBe("No session daemon is running.\n");
  });

  test("emits the structured status as JSON", async () => {
    const { deps } = createFakeDaemon({ probes: [adminStatus(12, "0.21.1", 1)] });
    const { io, out } = createIo();

    await runDaemonStatusCommand({ kind: "daemon-status", output: "json" }, io, deps);
    expect(JSON.parse(out.join(""))).toEqual({
      cli: CLIENT_BUILD,
      daemon: {
        daemonVersion: 12,
        appVersion: "0.21.1",
        pid: 4242,
        startedAt: "2026-09-08T09:42:00.000Z",
        uptimeMs: 11_520_000,
      },
      running: true,
      supportsAdminScope: true,
      direction: "client-newer",
      attachedSessions: [
        {
          sessionId: "session-1-0000-0000",
          title: "review 1",
          cwd: "/repo/1",
          pid: 100,
          clientDaemonVersion: 12,
          olderBuild: true,
        },
      ],
      launch: null,
    });
  });
});

describe("hunk daemon restart", () => {
  test("confirms, holds the launch lock across stop and start, and reports the new daemon", async () => {
    const { deps, journal } = createFakeDaemon({
      probes: [adminStatus(12, "0.21.1"), adminStatus(15, "0.22.0", 0)],
    });
    const { io, out, questions } = createIo([true]);

    expect(
      await runDaemonRestartCommand(
        { kind: "daemon-restart", output: "text", yes: false },
        io,
        deps,
      ),
    ).toBe(0);
    expect(questions).toEqual([
      "Restarting disconnects 2 attached windows. They must be relaunched, losing their notes. Continue? [y/N] ",
    ]);
    expect(journal).toEqual(["lock", "stop", "wait:down", "launch", "wait:up", "unlock"]);
    expect(out.join("")).toContain("Started session daemon 0.22.0, pid 4242.");
  });

  test("uses singular window wording when only one is attached", async () => {
    const { deps } = createFakeDaemon({ probes: [adminStatus(12, "0.21.1", 1)] });
    const { io, questions } = createIo([false]);
    await runDaemonRestartCommand({ kind: "daemon-restart", output: "text", yes: false }, io, deps);
    expect(questions).toEqual([
      "Restarting disconnects 1 attached window. They must be relaunched, losing their notes. Continue? [y/N] ",
    ]);
  });

  test("cancels without touching the daemon when the user declines", async () => {
    const { deps, journal } = createFakeDaemon({ probes: [adminStatus(12, "0.21.1")] });
    const { io, out } = createIo([false]);

    expect(
      await runDaemonRestartCommand(
        { kind: "daemon-restart", output: "text", yes: false },
        io,
        deps,
      ),
    ).toBe(1);
    expect(journal).toEqual([]);
    expect(out.join("")).toContain("Restart cancelled.");
  });

  test("refuses to prompt without a terminal unless --yes is given", async () => {
    const { deps, journal } = createFakeDaemon({
      probes: [adminStatus(12, "0.21.1")],
      isTerminal: false,
    });
    const { io, out } = createIo();

    await expect(
      runDaemonRestartCommand({ kind: "daemon-restart", output: "text", yes: false }, io, deps),
    ).rejects.toThrow("stdin is not a terminal");
    expect(journal).toEqual([]);
    // The summary still printed so a script's log says what would have been restarted.
    expect(out.join("")).toContain("Attached windows (2)");

    const { deps: yesDeps, journal: yesJournal } = createFakeDaemon({
      probes: [adminStatus(12, "0.21.1"), adminStatus(15, "0.22.0", 0)],
      isTerminal: false,
    });
    expect(
      await runDaemonRestartCommand(
        { kind: "daemon-restart", output: "json", yes: true },
        createIo().io,
        yesDeps,
      ),
    ).toBe(0);
    expect(yesJournal).toEqual(["lock", "stop", "wait:down", "launch", "wait:up", "unlock"]);
  });

  // Intent: the daemon being upgraded away from does not speak the admin scope. Signalling a pid
  // is the one-time bootstrap path and only ever happens after its own explicit confirmation.
  test("falls back to a separately confirmed SIGTERM for a pre-admin daemon", async () => {
    const { deps, journal } = createFakeDaemon({
      probes: [{ kind: "unsupported" }, adminStatus(15, "0.22.0", 0)],
    });
    const { io, questions } = createIo([true, true]);

    expect(
      await runDaemonRestartCommand(
        { kind: "daemon-restart", output: "text", yes: false },
        io,
        deps,
      ),
    ).toBe(0);
    expect(questions[0]).toBe(
      "Restarting disconnects an unknown number of attached windows. They must be relaunched, losing their notes. Continue? [y/N] ",
    );
    expect(questions[1]).toBe(
      "This daemon predates `hunk daemon restart`. Send SIGTERM to pid 777 (/usr/local/bin/hunk daemon serve)? [y/N] ",
    );
    expect(journal).toEqual([
      "lock",
      "kill:777:SIGTERM",
      "wait:down",
      "launch",
      "wait:up",
      "unlock",
    ]);
  });

  test("never signals a pid when the bootstrap confirmation is declined", async () => {
    const { deps, journal } = createFakeDaemon({ probes: [{ kind: "unsupported" }] });
    const { io } = createIo([true, false]);

    expect(
      await runDaemonRestartCommand(
        { kind: "daemon-restart", output: "text", yes: false },
        io,
        deps,
      ),
    ).toBe(1);
    expect(journal).toEqual(["lock", "unlock"]);
  });

  test("refuses the bootstrap path when no launch metadata names the pid", async () => {
    const { deps, journal } = createFakeDaemon({ probes: [{ kind: "unsupported" }], launch: null });

    await expect(
      runDaemonRestartCommand(
        { kind: "daemon-restart", output: "text", yes: true },
        createIo().io,
        deps,
      ),
    ).rejects.toThrow("launch metadata is missing");
    expect(journal).toEqual(["lock", "unlock"]);
  });

  test("starts a daemon without prompting when none is running", async () => {
    const { deps, journal } = createFakeDaemon({
      probes: [{ kind: "unavailable" }, adminStatus(15, "0.22.0", 0)],
      healthy: false,
    });
    const { io, questions } = createIo();

    expect(
      await runDaemonRestartCommand(
        { kind: "daemon-restart", output: "text", yes: false },
        io,
        deps,
      ),
    ).toBe(0);
    expect(questions).toEqual([]);
    expect(journal).toEqual(["lock", "launch", "wait:up", "unlock"]);
  });

  test("fails when another process holds the launch lock", async () => {
    const { deps } = createFakeDaemon({
      probes: [adminStatus(12, "0.21.1")],
      lockAvailable: false,
    });

    await expect(
      runDaemonRestartCommand(
        { kind: "daemon-restart", output: "text", yes: true },
        createIo().io,
        deps,
      ),
    ).rejects.toThrow("Another Hunk process is starting the session daemon");
  });

  test("emits before and after status as JSON", async () => {
    const { deps } = createFakeDaemon({
      probes: [adminStatus(12, "0.21.1"), adminStatus(15, "0.22.0", 0)],
    });
    const { io, out } = createIo();

    await runDaemonRestartCommand({ kind: "daemon-restart", output: "json", yes: true }, io, deps);
    expect(JSON.parse(out.join(""))).toMatchObject({
      restarted: true,
      before: { daemon: { daemonVersion: 12 }, direction: "client-newer" },
      after: { daemon: { daemonVersion: 15 }, direction: "matched", attachedSessions: [] },
    });
  });
});
