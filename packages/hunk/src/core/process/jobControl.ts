import type { CliRenderer, KeyEvent } from "@opentui/core";

type KeypressListener = (key: KeyEvent) => void;

type JobControlRenderer = Pick<CliRenderer, "isDestroyed" | "resume" | "suspend"> & {
  keyInput: {
    off: (event: "keypress", listener: KeypressListener) => unknown;
    on: (event: "keypress", listener: KeypressListener) => unknown;
  };
};

/** Test seams for installing process-level Unix job-control signal handling. */
export interface JobControlSuspendDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  platform?: NodeJS.Platform | string;
  /** Signal target passed to process.kill; defaults to 0 for the foreground process group. */
  pid?: number;
}

export interface JobControlSuspendSupport {
  /** Remove listeners installed for the lifetime of one app renderer. */
  dispose: () => void;
}

export interface JobControlInterruptSupport {
  /** Remove listeners installed for the lifetime of one app renderer. */
  dispose: () => void;
}

/** Match the parsed Ctrl-C shortcut that should quit the app in raw mode. */
function isCtrlC(key: KeyEvent) {
  return key.ctrl && !key.meta && !key.shift && key.name === "c";
}

/** Match the parsed Ctrl-Z shortcut that opencode binds to its terminal suspend command. */
function isCtrlZ(key: KeyEvent) {
  return key.ctrl && !key.meta && !key.shift && key.name === "z";
}

/** Install Ctrl-C handling that routes through the app's full shutdown path. */
export function installJobControlInterruptSupport(
  renderer: Pick<JobControlRenderer, "isDestroyed" | "keyInput">,
  onInterrupt: () => void,
): JobControlInterruptSupport {
  let disposed = false;

  const keypressListener: KeypressListener = (key) => {
    if (disposed || renderer.isDestroyed || !isCtrlC(key)) {
      return;
    }

    key.preventDefault();
    key.stopPropagation();
    onInterrupt();
  };

  renderer.keyInput.on("keypress", keypressListener);

  return {
    dispose: () => {
      disposed = true;
      renderer.keyInput.off("keypress", keypressListener);
    },
  };
}

/**
 * Install Ctrl-Z job-control suspend support for OpenTUI raw-mode input.
 *
 * OpenTUI receives Ctrl-Z as a parsed keypress instead of letting the terminal driver turn it into
 * SIGTSTP. Match the common TUI pattern used by apps like opencode: treat Ctrl-Z as an app command,
 * ask OpenTUI to restore the terminal, then send SIGTSTP to the foreground process group so the
 * shell can manage Hunk as a normal suspended job.
 *
 * For a normal shell-managed job, the stop takes effect inside `kill`, so the statement after it
 * runs only once the shell continues the job with `fg`. Suspend and resume are therefore one
 * straight line. Staying on that call stack is also what keeps the job alive, since OpenTUI's
 * suspend drops its keep-alive timer and stops reading stdin, so a runtime that reached an idle
 * event loop here could exit before being continued. A `kill` that returns without stopping — a
 * runtime that refuses SIGTSTP, or an orphaned process group that discards it — reaches the same
 * restore instead of waiting for a SIGCONT nobody will send.
 */
export function installJobControlSuspendSupport(
  renderer: JobControlRenderer,
  deps: JobControlSuspendDeps = {},
): JobControlSuspendSupport {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return { dispose: () => undefined };
  }

  const kill = deps.kill ?? process.kill.bind(process);
  const pid = deps.pid ?? 0;
  let disposed = false;

  const suspend = () => {
    renderer.suspend();

    try {
      // Blocks until the shell continues this job; see the note above.
      kill(pid, "SIGTSTP");
    } catch {
      // A runtime that refuses SIGTSTP leaves the app usable instead of half-suspended.
    }

    if (!renderer.isDestroyed) {
      renderer.resume();
    }
  };

  const keypressListener: KeypressListener = (key) => {
    if (disposed || renderer.isDestroyed || !isCtrlZ(key)) {
      return;
    }

    key.preventDefault();
    key.stopPropagation();
    suspend();
  };

  renderer.keyInput.on("keypress", keypressListener);

  return {
    dispose: () => {
      disposed = true;
      renderer.keyInput.off("keypress", keypressListener);
    },
  };
}
