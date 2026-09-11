/**
 * Agent-facing error messages for the `hunk session` surface.
 *
 * Every message quoted by the generated `packages/hunk/skills/hunk-review/SKILL.md` "Common errors" section is
 * defined (or contract-tested) here, so the skill can never quote wording the CLI no longer
 * throws. Throw sites import these builders instead of repeating string literals.
 */

import { HunkUserError } from "../../core/run/errors";
import {
  HUNK_BUILD_RELATION,
  HUNK_DAEMON_RESTART_COMMAND,
  HUNK_WINDOW_RELAUNCH_CLAUSE,
  daemonRestartDisconnects,
  describeAttachedWindows,
} from "../client/daemonMessages";
import type { AgentCommandConstraint } from "./surface";

/** Format flag choices as a human list: `--a, --b, or --c` for three, `--a or --b` for two. */
function formatFlagChoices(flags: readonly string[]) {
  if (flags.length <= 2) {
    return flags.join(" or ");
  }

  return `${flags.slice(0, -1).join(", ")}, or ${flags[flags.length - 1]}`;
}

/** The message thrown when one declared flag-group constraint is violated. */
export function constraintViolationMessage(constraint: AgentCommandConstraint) {
  if (constraint.kind === "exactly-one") {
    return `Specify exactly one ${constraint.label}: ${formatFlagChoices(constraint.flags)}.`;
  }

  return `Specify either ${formatFlagChoices(constraint.flags)}, not both.`;
}

/** Reload invoked without the `--` separator or without a nested review command. */
export const RELOAD_SEPARATOR_MESSAGE =
  "Pass the replacement Hunk command after `--`, for example `hunk session reload <session-id> -- diff`.";

/** `comment apply` invoked without opting into the stdin JSON batch. */
export const COMMENT_APPLY_STDIN_MESSAGE = "Pass --stdin to read batch comments from stdin JSON.";

/** `highlight add` invoked with an empty or inverted character range. */
export const HIGHLIGHT_RANGE_MESSAGE =
  "Highlight --end must be greater than --start; the range is [start, end) with an exclusive end.";

/** The daemon is reachable but no live Hunk session has registered with it. */
export const NO_ACTIVE_SESSIONS_MESSAGE =
  "No active Hunk sessions are registered with the daemon. Open Hunk and wait for it to connect.";

/** A navigation or comment target referenced a file outside the loaded review. */
export function noDiffFileMatchesMessage(filePath: string) {
  return `No diff file matches ${filePath}.`;
}

/**
 * Raw diff text could not be read back from the live session that published it.
 *
 * `review --include-patch` reads patch bodies as review resources rather than from the
 * registration, so this is what an agent sees when the session reloaded mid-read, went
 * away, or served content that failed verification.
 */
export function reviewResourceUnavailableMessage(filePath: string) {
  return `Could not read the raw diff for ${filePath} from the live session.`;
}

/** One build as the mismatch error describes it: the hello revision and the package version. */
export interface DaemonBuildMismatchBuild {
  daemonVersion: number;
  appVersion: string;
}

/** One attached window as reported by the daemon's admin scope. */
export interface DaemonBuildMismatchSession {
  sessionId: string;
  title: string;
  cwd: string;
  pid: number;
}

/**
 * Structured facts behind `daemon-build-mismatch`, returned verbatim under `--json` so an agent
 * can decide (and ask) before restarting anything.
 */
export interface DaemonBuildMismatchDetails {
  kind: "daemon-build-mismatch";
  /** The running daemon's build, or null when it predates the admin scope and cannot say. */
  daemon: DaemonBuildMismatchBuild | null;
  cli: DaemonBuildMismatchBuild;
  /** Attached windows when the admin scope answered; null when the daemon could not report them. */
  attachedSessions: { count: number; sessions: DaemonBuildMismatchSession[] } | null;
  /** What the daemon launch metadata says when the daemon itself could not be asked. */
  launch?: { pid: number; command: string; launchedAt: string };
  recommendedAction: "restart-daemon" | "use-newer-hunk";
}

/** Prefix shared by every mismatch message so the skill can quote one line for both directions. */
export const DAEMON_BUILD_MISMATCH_PREFIX = "The session daemon is";

/** The headline message for one mismatch. */
export function daemonBuildMismatchMessage(details: DaemonBuildMismatchDetails) {
  if (!details.daemon) {
    const launch = details.launch
      ? ` (pid ${details.launch.pid}, started ${details.launch.launchedAt}, command ${details.launch.command})`
      : "";
    return `${DAEMON_BUILD_MISMATCH_PREFIX} ${HUNK_BUILD_RELATION.older} that predates \`hunk daemon status\` and refuses this CLI${launch}.`;
  }
  const relation =
    HUNK_BUILD_RELATION[details.recommendedAction === "restart-daemon" ? "older" : "newer"];
  return `${DAEMON_BUILD_MISMATCH_PREFIX} ${relation} and refuses this CLI.`;
}

/** The remedy lines that follow the headline in text output. */
export function daemonBuildMismatchSuggestions(details: DaemonBuildMismatchDetails) {
  const count = details.attachedSessions?.count ?? null;
  if (details.recommendedAction === "use-newer-hunk") {
    return [
      `Use the newer Hunk build the daemon was started from, or run ${HUNK_DAEMON_RESTART_COMMAND} from this build (${describeAttachedWindows(count)} would be disconnected and could not reconnect).`,
    ];
  }
  return [
    `Run ${HUNK_DAEMON_RESTART_COMMAND} to replace it, then re-run \`hunk session list\`; windows that could not register attach automatically.`,
    `${daemonRestartDisconnects(count)}; they ${HUNK_WINDOW_RELAUNCH_CLAUSE} Closing them instead lets the daemon exit on its own after about a minute.`,
  ];
}

/** Thrown by every `hunk session *` command when the daemon and this CLI disagree on the build. */
export class DaemonBuildMismatchError extends HunkUserError {
  constructor(readonly details: DaemonBuildMismatchDetails) {
    super(daemonBuildMismatchMessage(details), daemonBuildMismatchSuggestions(details));
    this.name = "DaemonBuildMismatchError";
  }

  /** The `--json` error body: the message plus every structured fact. */
  toJSON() {
    return { message: this.message, ...this.details };
  }
}

/** One skill-documented error: the quoted message (or prefix) plus the remedy agents should try. */
export interface AgentErrorDoc {
  /**
   * Text quoted in the skill. A trailing ` ...` marks a prefix of a longer dynamic message;
   * tests strip it and assert the real thrown message starts with the rest.
   */
  quote: string;
  /** Skill guidance rendered after the quote. */
  remedy: string;
}

/**
 * The generated skill's "Common errors" section, in display order. Messages owned by
 * `@hunk/session-broker-core` stay defined there (the broker core is app-agnostic); their quotes
 * are bound to the real wording by contract tests in `agentErrors.test.ts`.
 */
export const AGENT_ERROR_DOCS: AgentErrorDoc[] = [
  {
    quote: "No diff file matches ...",
    remedy: "the file is not in the loaded review. Check `context`, then `reload` if needed.",
  },
  {
    quote: "No active Hunk sessions",
    remedy:
      "if Hunk is visibly running, localhost may be blocked by the agent sandbox; retry with network/sandbox escalation. Otherwise ask the user to open Hunk.",
  },
  {
    quote: "Multiple active sessions match",
    remedy: "pass `<session-id>` explicitly.",
  },
  {
    quote: "No active session matches session path ...",
    remedy:
      "for advanced split-path reloads, verify the live window `Path` via `hunk session get` or `list`, then use `--session-path`.",
  },
  {
    quote: "Pass the replacement Hunk command after `--`",
    remedy: "include `--` before the nested `diff` / `show` command.",
  },
  {
    quote: COMMENT_APPLY_STDIN_MESSAGE,
    remedy: "`comment apply` only reads its batch payload from stdin.",
  },
  {
    quote: "Specify exactly one navigation target",
    remedy: "pick one of `--hunk`, `--old-line`, or `--new-line`.",
  },
  {
    quote: "Specify exactly one comment target",
    remedy: "pass `comment add` one of `--old-line` or `--new-line`.",
  },
  {
    quote: "Specify exactly one highlight target",
    remedy: "pass `highlight add` one of `--old-line` or `--new-line`.",
  },
  {
    quote: "Highlight --end must be greater than --start",
    remedy: "offsets are `[start, end)` UTF-16 code units into the line text; end is exclusive.",
  },
  {
    quote: "Specify either --next-comment or --prev-comment, not both.",
    remedy: "choose one comment-navigation direction.",
  },
  {
    quote: `${DAEMON_BUILD_MISMATCH_PREFIX} ...`,
    remedy:
      "a `daemon-build-mismatch` (the `--json` error carries `daemon`, `cli`, `attachedSessions`, and `recommendedAction`). Tell the user which build is newer and how many windows are attached, then **ask** before running `hunk daemon restart --yes`; never restart unprompted. After the restart, windows that failed to register attach on their own, so re-run `hunk session list` instead of relaunching anything. When `recommendedAction` is `use-newer-hunk`, the daemon is the newer build: use that Hunk instead.",
  },
  {
    quote: "Could not read the raw diff for ...",
    remedy:
      "the session reloaded or closed while `--include-patch` was reading it. Re-run `review`; drop `--include-patch` if you only need file and hunk structure.",
  },
];

/** Strip the trailing ` ...` prefix marker from one documented quote. */
export function agentErrorQuotePrefix(doc: AgentErrorDoc) {
  return doc.quote.endsWith(" ...") ? doc.quote.slice(0, -" ...".length) : doc.quote;
}
