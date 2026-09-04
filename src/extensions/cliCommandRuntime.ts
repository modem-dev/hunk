import { validateExtensionReviewDescriptor } from "../core/reviewDescriptor";
import { HunkUserError, isUserFacingError, toUserFacingError } from "../core/run/errors";
import type {
  ExtensionCliCommandContext,
  ExtensionCliCommandHandler,
  ExtensionCliCommandResult,
  ExtensionCliWriter,
} from "./types";
import { describeError } from "./runExtension";

export interface ExtensionCliWritable {
  write(chunk: string | Uint8Array, callback: (error?: Error | null) => void): unknown;
}

export interface ExtensionCliSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface RunExtensionCliCommandOptions {
  extensionId: string;
  commandName: string;
  args: readonly string[];
  handler: ExtensionCliCommandHandler;
  cwd?: string;
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: ExtensionCliWritable;
  stderr?: ExtensionCliWritable;
  signals?: ExtensionCliSignalSource;
}

export interface ExtensionCliCommandExecution {
  result: ExtensionCliCommandResult;
  stdinReadStarted: boolean;
  stdinConsumed: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

/** Count bytes written through one leased output capability. */
function chunkByteLength(chunk: string | Uint8Array) {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength;
}

/**
 * Reject a revoked or invalid write without leaving an unhandled rejection behind.
 *
 * A handler that fires a write it never awaits — a `setTimeout` progress line landing after
 * settlement is the usual shape — would otherwise crash the process and replace the command's
 * real exit status. The rejection still reaches any caller that awaits it.
 */
function rejectWrite(error: Error): Promise<void> {
  const rejected = Promise.reject(error);
  void rejected.catch(() => undefined);
  return rejected;
}

/** Wrap a process-owned stream without granting close or post-handler access. */
function createLeasedWriter(
  stream: ExtensionCliWritable,
  active: () => boolean,
  record: (bytes: number) => void,
  pendingWrites: Set<Promise<void>>,
): ExtensionCliWriter {
  return Object.freeze({
    write(chunk: string | Uint8Array) {
      if (!active()) {
        return rejectWrite(new Error("Extension CLI output is no longer available."));
      }
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
        return rejectWrite(new TypeError("Extension CLI output must be a string or Uint8Array."));
      }

      record(chunkByteLength(chunk));
      const pending = new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      pendingWrites.add(pending);
      const removePending = () => pendingWrites.delete(pending);
      // Keep a rejected write in the set so settlement observes the failure even if the handler
      // discarded the returned promise; fulfilled writes no longer need to be awaited.
      void pending.then(removePending, () => undefined);
      return pending;
    },
  });
}

interface TrackedStdinLease {
  stdin: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

/** Wrap stdin so settlement revokes and closes every iterator the handler started. */
function createTrackedStdin(
  source: AsyncIterable<string | Uint8Array>,
  markReadStarted: () => void,
  markConsumed: () => void,
): TrackedStdinLease {
  let revoked = false;
  let closePromise: Promise<void> | undefined;
  const activeCloses = new Set<() => Promise<void>>();
  const pendingReads = new Set<Promise<IteratorResult<Uint8Array>>>();
  const stdin: AsyncIterable<Uint8Array> = Object.freeze({
    [Symbol.asyncIterator]() {
      let iterator: AsyncIterator<string | Uint8Array> | undefined;
      let settled = false;
      const getIterator = () => {
        if (revoked) {
          throw new Error("Extension CLI stdin is no longer available.");
        }
        if (!iterator) {
          iterator = source[Symbol.asyncIterator]();
          activeCloses.add(close);
        }
        return iterator;
      };
      const close = async () => {
        if (settled) return;
        settled = true;
        activeCloses.delete(close);
        if (iterator?.return) await iterator.return();
      };
      return {
        next() {
          const pending = (async (): Promise<IteratorResult<Uint8Array>> => {
            if (settled || revoked) {
              throw new Error("Extension CLI stdin is no longer available.");
            }
            markReadStarted();
            try {
              const next = await getIterator().next();
              if (settled || revoked || next.done) {
                await close();
                return { done: true as const, value: undefined };
              }
              markConsumed();
              return {
                done: false as const,
                value:
                  typeof next.value === "string"
                    ? new TextEncoder().encode(next.value)
                    : next.value,
              };
            } catch (error) {
              await close();
              throw error;
            }
          })();
          pendingReads.add(pending);
          const removePending = () => pendingReads.delete(pending);
          void pending.then(removePending, () => undefined);
          return pending;
        },
        async return() {
          await close();
          return { done: true as const, value: undefined };
        },
      };
    },
  });

  return {
    stdin,
    close() {
      closePromise ??= (async () => {
        revoked = true;
        const closeResults = await Promise.allSettled([...activeCloses].map((close) => close()));
        const readResults = await Promise.allSettled(pendingReads);
        const failed = [...closeResults, ...readResults].find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) throw failed.reason;
      })();
      return closePromise;
    },
  };
}

/** Validate and freeze the result returned by one extension CLI handler. */
function validateExtensionCliResult(result: unknown): ExtensionCliCommandResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error('must return an object with kind "exit" or "delegate"');
  }

  const candidate = result as { kind?: unknown; code?: unknown; argv?: unknown; review?: unknown };
  if (candidate.kind === "exit") {
    if ("review" in candidate) {
      throw new Error("exit results cannot include delegated review metadata");
    }
    const code = candidate.code ?? 0;
    if (!Number.isSafeInteger(code) || (code as number) < 0 || (code as number) > 255) {
      throw new Error("exit code must be a safe integer from 0 through 255");
    }
    return Object.freeze({ kind: "exit", code: code as number });
  }

  if (candidate.kind === "delegate") {
    if (!Array.isArray(candidate.argv) || candidate.argv.length === 0) {
      throw new Error("delegate argv must be a non-empty array of strings");
    }
    if (candidate.argv.some((token) => typeof token !== "string" || token.includes("\0"))) {
      throw new Error("delegate argv must contain only strings without NUL characters");
    }
    const argv = candidate.argv as string[];
    if (
      argv.some(
        (token) =>
          token === "--extension" ||
          token.startsWith("--extension=") ||
          token === "--extensions" ||
          token === "--no-extensions",
      )
    ) {
      throw new Error("delegate argv cannot change extension bootstrap flags");
    }
    const review =
      candidate.review === undefined
        ? undefined
        : validateExtensionReviewDescriptor(candidate.review);
    return Object.freeze({
      kind: "delegate",
      argv: Object.freeze([...argv]),
      ...(review === undefined ? {} : { review }),
    });
  }

  throw new Error('result kind must be "exit" or "delegate"');
}

/** Iterate Bun stdin without cancelling the shared stream when a handler stops early. */
function defaultCliStdin(): AsyncIterable<Uint8Array> {
  const stream = Bun.stdin.stream();
  return {
    [Symbol.asyncIterator]() {
      const reader = stream.getReader();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        reader.releaseLock();
      };
      return {
        async next() {
          try {
            const result = await reader.read();
            if (result.done) {
              release();
              return { done: true as const, value: undefined };
            }
            return { done: false as const, value: result.value };
          } catch (error) {
            release();
            throw error;
          }
        },
        async return() {
          if (!released) {
            try {
              await reader.cancel();
            } finally {
              release();
            }
          }
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

/** Invoke one extension CLI handler with leased streams and cooperative cancellation. */
export async function runExtensionCliCommand(
  options: RunExtensionCliCommandOptions,
): Promise<ExtensionCliCommandExecution> {
  const cwd = options.cwd ?? process.cwd();
  const stdin = options.stdin ?? defaultCliStdin();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const signals = options.signals ?? process;
  const controller = new AbortController();
  let active = true;
  let stdinReadStarted = false;
  let stdinConsumed = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const pendingWrites = new Set<Promise<void>>();

  const abort = (signal: "SIGINT" | "SIGTERM") => () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Extension CLI command interrupted by ${signal}.`));
    }
    // Restore the default disposition for a second signal if the handler ignores cancellation.
    signals.off(signal, signal === "SIGINT" ? onSigint : onSigterm);
  };
  const onSigint = abort("SIGINT");
  const onSigterm = abort("SIGTERM");
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", onSigterm);

  const stdinLease = createTrackedStdin(
    stdin,
    () => {
      stdinReadStarted = true;
    },
    () => {
      stdinConsumed = true;
    },
  );
  const context: ExtensionCliCommandContext = Object.freeze({
    cwd,
    signal: controller.signal,
    stdin: stdinLease.stdin,
    stdout: createLeasedWriter(
      stdout,
      () => active,
      (bytes) => {
        stdoutBytes += bytes;
      },
      pendingWrites,
    ),
    stderr: createLeasedWriter(
      stderr,
      () => active,
      (bytes) => {
        stderrBytes += bytes;
      },
      pendingWrites,
    ),
  });

  try {
    const args = Object.freeze([...options.args]);
    let returned: unknown;
    let handlerFailed = false;
    let handlerFailure: unknown;
    try {
      returned = await options.handler(args, context);
    } catch (error) {
      handlerFailed = true;
      handlerFailure = error;
    }

    // Settlement closes every capability before draining work already accepted through it.
    active = false;
    const writesAtSettlement = [...pendingWrites];
    const [stdinSettlement, writeSettlements] = await Promise.all([
      stdinLease.close().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
      Promise.allSettled(writesAtSettlement),
    ]);

    try {
      if (handlerFailed) throw handlerFailure;
      if (stdinSettlement.status === "rejected") throw stdinSettlement.reason;
      const failedWrite = writeSettlements.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failedWrite) throw failedWrite.reason;

      const result = validateExtensionCliResult(returned);
      if (result.kind === "delegate" && stdoutBytes > 0) {
        throw new HunkUserError(
          `Extension ${options.extensionId} wrote to stdout before delegating to Hunk.`,
          [
            "Write preprocessing progress to ctx.stderr, or return an exit result after stdout output.",
          ],
        );
      }

      return { result, stdinReadStarted, stdinConsumed, stdoutBytes, stderrBytes };
    } catch (error) {
      const userError = toUserFacingError(error);
      if (isUserFacingError(userError)) throw userError;
      throw new Error(
        `Extension ${options.extensionId} CLI command "${options.commandName}" failed: ${describeError(error)}`,
        { cause: error },
      );
    }
  } finally {
    active = false;
    await stdinLease.close().catch(() => undefined);
    await Promise.allSettled(pendingWrites);
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
  }
}
