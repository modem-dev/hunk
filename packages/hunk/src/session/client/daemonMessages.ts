/** Shares build-skew wording across window notices, agent errors, and daemon commands. */
export const HUNK_BUILD_RELATION = {
  older: "an older Hunk build",
  newer: "a newer Hunk build",
} as const;

export const HUNK_DAEMON_RESTART_COMMAND = "`hunk daemon restart`";
export const HUNK_WINDOW_RELAUNCH_CLAUSE = "must be relaunched, losing their notes.";

/** Names the attached windows without guessing when the daemon cannot report a count. */
export function describeAttachedWindows(count: number | null) {
  return count === null
    ? "an unknown number of attached windows"
    : `${count} attached window${count === 1 ? "" : "s"}`;
}

/** States the restart cost shared by agent remedies and confirmation prompts. */
export function daemonRestartDisconnects(count: number | null) {
  return `Restarting disconnects ${describeAttachedWindows(count)}`;
}

/** Keeps unknown-build notices actionable before the admin probe answers. */
export const HUNK_DAEMON_UPGRADE_WAIT_MESSAGE = `Session daemon is a different Hunk build. Run ${HUNK_DAEMON_RESTART_COMMAND}.`;

/** Tells a newer window how to replace the daemon without relaunching itself. */
export const HUNK_DAEMON_CLIENT_NEWER_MESSAGE = `Session daemon is ${HUNK_BUILD_RELATION.older}. Run ${HUNK_DAEMON_RESTART_COMMAND}.`;

/** Tells an older window to relaunch because replacing a newer daemon cannot upgrade it. */
export const HUNK_DAEMON_CLIENT_OLDER_MESSAGE =
  "Session daemon is newer; relaunch this window (notes are lost).";

/** Covers a refused registration after the daemon accepted the window's hello. */
export const HUNK_DAEMON_REGISTRATION_REJECTED_MESSAGE = `Session daemon rejected this window. Run ${HUNK_DAEMON_RESTART_COMMAND}.`;
