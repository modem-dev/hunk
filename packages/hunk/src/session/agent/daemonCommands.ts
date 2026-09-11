import type { DaemonControlCommandInput } from "../../core/run/commandInputs";
import { HunkUserError } from "../../core/run/errors";
import {
  createNativeSessionBrokerLifecycleClock,
  type SessionBrokerAdminStatusV1,
} from "@hunk/session-broker";
import {
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "../broker/brokerConfig";
import {
  isSessionBrokerHealthy,
  launchSessionBrokerDaemonAndRecord,
  readSessionBrokerLaunchMetadata,
  tryAcquireDaemonLaunchLock,
  waitForSessionBrokerHealth,
  type SessionBrokerLaunchMetadata,
} from "../broker/brokerLauncher";
import {
  probeHunkSessionDaemonAdminStatus,
  requestHunkSessionDaemonStop,
  type HunkDaemonAdminProbe,
} from "../client/daemonAdmin";
import {
  compareDaemonBuild,
  currentDaemonBuild,
  type DaemonBuild,
  type DaemonSkewDirection,
} from "../client/daemonSkew";
import {
  HUNK_BUILD_RELATION,
  HUNK_DAEMON_RESTART_COMMAND,
  HUNK_WINDOW_RELAUNCH_CLAUSE,
  daemonRestartDisconnects,
} from "../client/daemonMessages";
import { stringifyJson } from "./cliClient";

/**
 * Implements `hunk daemon status` and `hunk daemon restart`.
 *
 * Both start by asking the daemon's revision-tolerant admin scope what it is and which windows
 * are attached, so the summary and the restart prompt can say what a restart costs. Restart is
 * the only supported way to replace a daemon: it takes the launch lock first so no attached
 * window can respawn the old binary, stops the daemon through the admin scope (or, for a daemon
 * from before the scope existed, by a separately confirmed SIGTERM to the pid in the launch
 * metadata), waits for the port to clear, and spawns the replacement from this CLI's own binary.
 * Nothing here ever replaces a daemon without the user asking for it.
 */
export interface DaemonCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Ask one yes/no question; absent when stdin is not a terminal. */
  confirm?: (question: string) => Promise<boolean>;
}

/** Collaborators the commands reach the daemon and the process table through; tests fake these. */
export interface DaemonCommandDependencies {
  config: ResolvedSessionBrokerConfig;
  clientBuild: DaemonBuild;
  probeAdminStatus: () => Promise<HunkDaemonAdminProbe>;
  requestStop: () => Promise<"stopping" | "unsupported" | "unavailable">;
  readLaunchMetadata: () => SessionBrokerLaunchMetadata | null;
  isHealthy: () => Promise<boolean>;
  acquireLaunchLock: () => { release: () => void } | null;
  launchDaemon: () => SessionBrokerLaunchMetadata | null;
  waitForHealth: (expected: boolean, timeoutMs: number) => Promise<"ready" | "timeout">;
  killProcess: (pid: number, signal: "SIGTERM") => void;
  isTerminal: boolean;
}

/** What `status` learned, in the shape both commands and both output formats consume. */
export type DaemonStatusReport =
  | { kind: "none" }
  | { kind: "pre-admin"; launch: SessionBrokerLaunchMetadata | null }
  | {
      kind: "status";
      status: SessionBrokerAdminStatusV1;
      direction: DaemonSkewDirection;
    };

const STOP_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 5_000;

/** Wire the real daemon, filesystem, and process collaborators. */
export function createDaemonCommandDependencies(
  config = resolveSessionBrokerConfig(),
): DaemonCommandDependencies {
  const lifecycleClock = createNativeSessionBrokerLifecycleClock();
  return {
    config,
    clientBuild: currentDaemonBuild(),
    probeAdminStatus: () => probeHunkSessionDaemonAdminStatus(config),
    requestStop: () => requestHunkSessionDaemonStop(config),
    readLaunchMetadata: () => readSessionBrokerLaunchMetadata(config),
    isHealthy: () => isSessionBrokerHealthy(config),
    acquireLaunchLock: () => tryAcquireDaemonLaunchLock({ config, lifecycleClock }),
    launchDaemon: () => launchSessionBrokerDaemonAndRecord({ config }),
    waitForHealth: (expected, timeoutMs) =>
      waitForSessionBrokerHealth({ config, expected, timeoutMs, lifecycleClock }),
    killProcess: (pid, signal) => process.kill(pid, signal),
    isTerminal: Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
  };
}

/** Ask the daemon what it is, falling back to launch metadata and then to "nothing running". */
export async function readDaemonStatusReport(
  deps: DaemonCommandDependencies,
): Promise<DaemonStatusReport> {
  const probe = await deps.probeAdminStatus();
  if (probe.kind === "status") {
    return {
      kind: "status",
      status: probe.status,
      direction: compareDaemonBuild(probe.status.daemonVersion, deps.clientBuild.daemonVersion),
    };
  }
  if (probe.kind === "unsupported" || (await deps.isHealthy())) {
    return { kind: "pre-admin", launch: deps.readLaunchMetadata() };
  }
  return { kind: "none" };
}

/** Format a millisecond duration as a compact `1d 2h 3m` style string. */
function formatUptime(uptimeMs: number) {
  const totalMinutes = Math.floor(uptimeMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(uptimeMs / 1_000)}s`;
}

/** The launch metadata line shared by the pre-admin summary and the bootstrap prompt. */
function describeLaunch(launch: SessionBrokerLaunchMetadata) {
  return `pid ${launch.pid}, started ${launch.launchedAt}, command ${[launch.command, ...launch.args].join(" ")}`;
}

/** Render the status summary lines shown by both commands. */
export function formatDaemonStatusReport(report: DaemonStatusReport) {
  if (report.kind === "none") return ["No session daemon is running."];
  if (report.kind === "pre-admin") {
    return [
      report.launch
        ? `A session daemon is running (${describeLaunch(report.launch)}), but it is from a build that predates \`hunk daemon status\` and cannot report itself.`
        : "A session daemon is running, but it is from a build that predates `hunk daemon status` and cannot report itself; no launch metadata was found.",
      `This CLI is ${HUNK_BUILD_RELATION.newer}.`,
    ];
  }
  const { status, direction } = report;
  const lines = [
    `Session daemon ${status.appVersion}, pid ${status.pid}, up ${formatUptime(status.uptimeMs)} (started ${status.startedAt}).`,
  ];
  if (direction !== "matched") {
    lines.push(
      `This CLI is ${HUNK_BUILD_RELATION[direction === "client-newer" ? "newer" : "older"]}, so the daemon refuses it.`,
    );
  }
  if (status.sessions.length === 0) {
    lines.push("No windows are attached.");
  } else {
    lines.push(
      direction === "matched"
        ? `Attached windows (${status.sessions.length}):`
        : `Attached windows (${status.sessions.length}). A restart disconnects them; they ${HUNK_WINDOW_RELAUNCH_CLAUSE}`,
    );
    for (const session of status.sessions) {
      lines.push(`  ${session.sessionId.slice(0, 8)}  ${session.title}  ${session.cwd}`);
    }
  }
  return lines;
}

/** The JSON body for `status --json` and the `before` half of `restart --json`. */
function statusReportJson(report: DaemonStatusReport, clientBuild: DaemonBuild) {
  return {
    cli: clientBuild,
    daemon:
      report.kind === "status"
        ? {
            daemonVersion: report.status.daemonVersion,
            appVersion: report.status.appVersion,
            pid: report.status.pid,
            startedAt: report.status.startedAt,
            uptimeMs: report.status.uptimeMs,
          }
        : null,
    running: report.kind !== "none",
    supportsAdminScope: report.kind === "status",
    direction: report.kind === "status" ? report.direction : null,
    attachedSessions:
      report.kind === "status"
        ? report.status.sessions.map((session) => ({
            ...session,
            olderBuild:
              compareDaemonBuild(session.clientDaemonVersion, clientBuild.daemonVersion) !==
              "matched",
          }))
        : null,
    launch:
      report.kind === "pre-admin" && report.launch
        ? {
            pid: report.launch.pid,
            command: [report.launch.command, ...report.launch.args].join(" "),
            launchedAt: report.launch.launchedAt,
          }
        : null,
  };
}

/** Run `hunk daemon status`. */
export async function runDaemonStatusCommand(
  input: Extract<DaemonControlCommandInput, { kind: "daemon-status" }>,
  io: DaemonCommandIo,
  deps: DaemonCommandDependencies = createDaemonCommandDependencies(),
) {
  const report = await readDaemonStatusReport(deps);
  if (input.output === "json") {
    io.stdout(stringifyJson(statusReportJson(report, deps.clientBuild)));
  } else {
    io.stdout(`${formatDaemonStatusReport(report).join("\n")}\n`);
  }
  return 0;
}

/** The confirmation shown before any restart; names the cost in windows. */
function restartQuestion(report: DaemonStatusReport) {
  const count = report.kind === "status" ? report.status.sessions.length : null;
  return `${daemonRestartDisconnects(count)}. They ${HUNK_WINDOW_RELAUNCH_CLAUSE} Continue? [y/N] `;
}

/** Ask one question, honoring `--yes` and refusing to guess without a terminal. */
async function confirmOrFail(
  question: string,
  input: Extract<DaemonControlCommandInput, { kind: "daemon-restart" }>,
  io: DaemonCommandIo,
  deps: DaemonCommandDependencies,
) {
  if (input.yes) return true;
  if (!deps.isTerminal || !io.confirm) {
    throw new HunkUserError(
      "`hunk daemon restart` needs confirmation and stdin is not a terminal.",
      ["Re-run with --yes to restart without a prompt."],
    );
  }
  return io.confirm(question);
}

/** Run `hunk daemon restart`. */
export async function runDaemonRestartCommand(
  input: Extract<DaemonControlCommandInput, { kind: "daemon-restart" }>,
  io: DaemonCommandIo,
  deps: DaemonCommandDependencies = createDaemonCommandDependencies(),
) {
  const before = await readDaemonStatusReport(deps);
  const summary = formatDaemonStatusReport(before);
  const log = (line: string) => {
    if (input.output !== "json") io.stdout(`${line}\n`);
  };
  for (const line of summary) log(line);

  if (before.kind !== "none") {
    if (!(await confirmOrFail(restartQuestion(before), input, io, deps))) {
      log("Restart cancelled.");
      return 1;
    }
  }

  // Hold the launch lock across stop and start so an attached window's reconnect loop cannot
  // race in and respawn the binary that is being replaced.
  const lock = deps.acquireLaunchLock();
  if (!lock) {
    throw new HunkUserError(
      "Another Hunk process is starting the session daemon right now; retry in a moment.",
    );
  }
  try {
    if (before.kind === "status") {
      const stop = await deps.requestStop();
      if (stop !== "stopping") {
        throw new HunkUserError(`The session daemon did not accept the stop request (${stop}).`);
      }
      log("Asked the session daemon to stop.");
    } else if (before.kind === "pre-admin") {
      const pid = before.launch?.pid;
      if (!pid) {
        throw new HunkUserError(
          `This daemon predates ${HUNK_DAEMON_RESTART_COMMAND} and its launch metadata is missing, so it cannot be stopped safely.`,
          ["Stop it by hand, then run `hunk daemon restart` again."],
        );
      }
      const question = `This daemon predates ${HUNK_DAEMON_RESTART_COMMAND}. Send SIGTERM to pid ${pid} (${[before.launch!.command, ...before.launch!.args].join(" ")})? [y/N] `;
      if (!(await confirmOrFail(question, input, io, deps))) {
        log("Restart cancelled.");
        return 1;
      }
      deps.killProcess(pid, "SIGTERM");
      log(`Sent SIGTERM to pid ${pid}.`);
    }

    if (before.kind !== "none") {
      const stopped = await deps.waitForHealth(false, STOP_TIMEOUT_MS);
      if (stopped !== "ready") {
        throw new HunkUserError("The session daemon is still answering after the stop request.", [
          "Wait a moment and retry, or stop the process by hand.",
        ]);
      }
    }

    const launched = deps.launchDaemon();
    if (!launched) throw new HunkUserError("Failed to launch the replacement session daemon.");
    const started = await deps.waitForHealth(true, START_TIMEOUT_MS);
    if (started !== "ready") {
      throw new HunkUserError("The replacement session daemon did not become healthy.", [
        "Run `hunk daemon serve` in a terminal to see why it fails to start.",
      ]);
    }
  } finally {
    lock.release();
  }

  const after = await readDaemonStatusReport(deps);
  if (input.output === "json") {
    io.stdout(
      stringifyJson({
        restarted: true,
        before: statusReportJson(before, deps.clientBuild),
        after: statusReportJson(after, deps.clientBuild),
      }),
    );
  } else if (after.kind === "status") {
    log(`Started session daemon ${after.status.appVersion}, pid ${after.status.pid}.`);
  } else {
    log("Started a replacement session daemon.");
  }
  return 0;
}

/** Dispatch one daemon control command by kind. */
export function runDaemonControlCommand(
  input: DaemonControlCommandInput,
  io: DaemonCommandIo,
  deps?: DaemonCommandDependencies,
) {
  return input.kind === "daemon-status"
    ? runDaemonStatusCommand(input, io, deps)
    : runDaemonRestartCommand(input, io, deps);
}
