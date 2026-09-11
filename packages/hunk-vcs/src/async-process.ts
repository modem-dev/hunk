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
    maxOutputBytes,
    timeoutMs,
    strictUtf8 = false,
  }: {
    cwd: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    terminationGraceMs?: number;
    /** Bound combined stdout/stderr bytes; exceeding this rejects after reaping the child. */
    maxOutputBytes?: number;
    timeoutMs?: number;
    /** Refuse undecodable machine paths instead of replacing their bytes with U+FFFD. */
    strictUtf8?: boolean;
  },
): Promise<AsyncCommandResult> {
  signal?.throwIfAborted();
  for (const value of [maxOutputBytes, timeoutMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("Command bounds must be positive integers.");
    }
  }
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

  let failure: Error | undefined;
  let outputBytes = 0;
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          failure ??= new Error(`Command exceeded ${timeoutMs}ms timeout.`);
          abort();
        }, timeoutMs);
  /** Drain terminated pipes without retaining output beyond the shared byte budget. */
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        outputBytes += value.byteLength;
        if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
          failure ??= new Error(`Command exceeded ${maxOutputBytes} output bytes.`);
          abort();
        }
        if (!failure) chunks.push(value);
      }
      const output = Buffer.concat(chunks);
      return strictUtf8
        ? new TextDecoder("utf-8", { fatal: true }).decode(output)
        : output.toString("utf8");
    } catch (error) {
      abort();
      throw error;
    } finally {
      reader.releaseLock();
    }
  };
  const stdoutResult = collect(proc.stdout);
  const stderrResult = collect(proc.stderr);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([stdoutResult, stderrResult, proc.exited]);
    signal?.throwIfAborted();
    if (failure) throw failure;
    return { stdout, stderr, exitCode };
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (timeout) clearTimeout(timeout);
    // Keep escalation live until both pipes and the process are reaped, including read errors.
    await Promise.allSettled([stdoutResult, stderrResult, proc.exited]);
    if (killTimer) clearTimeout(killTimer);
    // Windows tree-kill helpers may have been added by escalation while reaping.
    await Promise.all(treeTerminationTasks);
  }
}
