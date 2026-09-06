const DEFAULT_TERMINATION_GRACE_MS = 250;

export interface AsyncCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run one provider command without blocking renderer input and reap it after cancellation. */
export async function runAbortableCommand(
  command: string[],
  {
    cwd,
    env,
    signal,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  }: {
    cwd: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    terminationGraceMs?: number;
  },
): Promise<AsyncCommandResult> {
  signal?.throwIfAborted();
  const ownsProcessGroup = process.platform !== "win32";
  const proc = Bun.spawn(command, {
    cwd,
    env,
    detached: ownsProcessGroup,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let terminating = false;
  const treeTerminationTasks: Promise<unknown>[] = [];
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    if (ownsProcessGroup) {
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch {
        // Fall back when the child exited before its process group was signalled.
      }
    }
    if (process.platform === "win32") {
      // Bun cannot signal a Windows process group. taskkill owns the complete descendant
      // tree so helpers that inherited our pipes cannot keep stream collection pending.
      const task = Bun.spawn(
        ["taskkill", "/pid", String(proc.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      treeTerminationTasks.push(task.exited.catch(() => undefined));
      return;
    }
    proc.kill(signal);
  };
  const abort = () => {
    if (terminating) return;
    terminating = true;
    try {
      kill("SIGTERM");
    } catch {
      // The process may already have exited between the abort and this handler.
    }
    killTimer = setTimeout(() => {
      try {
        kill("SIGKILL");
      } catch {
        // Reaping below remains authoritative when the process already exited.
      }
    }, terminationGraceMs);
    killTimer.unref?.();
  };
  signal?.addEventListener("abort", abort, { once: true });
  // Close the race between the pre-spawn check and listener registration.
  if (signal?.aborted) abort();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    signal?.throwIfAborted();
    return { stdout, stderr, exitCode };
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    // `proc.exited` also reaps a child terminated during stream collection. Windows
    // tree-kill helpers are awaited as well so cancellation leaves no owned processes.
    await Promise.all([proc.exited.catch(() => undefined), ...treeTerminationTasks]);
  }
}
