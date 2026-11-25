/**
 * Lists the OS signals that end a review, whether it runs in the terminal UI or headless with
 * `--web`, so both surfaces stop on the same events.
 *
 * Windows delivers Ctrl+Break as SIGBREAK. Elsewhere a closed terminal sends SIGHUP, Ctrl+\ sends
 * SIGQUIT, and SIGPIPE arrives when a write finds that whoever started the review closed its
 * output or died; Bun otherwise ignores SIGPIPE and the orphan lives on. Fatal process faults keep
 * their default OS disposition.
 */
export const REVIEW_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGPIPE"];
