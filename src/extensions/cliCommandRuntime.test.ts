import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { HunkExtensionUserError } from "../extension-api/types";
import { runExtensionCliCommand, type ExtensionCliWritable } from "./cliCommandRuntime";

/** Capture leased output chunks while satisfying the runtime writable seam. */
function createTestWriter(chunks: Array<string | Uint8Array>): ExtensionCliWritable {
  return {
    write(chunk, callback) {
      chunks.push(chunk);
      queueMicrotask(() => callback());
      return true;
    },
  };
}

describe("extension CLI command runtime", () => {
  test("freezes args, streams bytes, and validates exit codes", async () => {
    const stdout: Array<string | Uint8Array> = [];
    const stderr: Array<string | Uint8Array> = [];
    const execution = await runExtensionCliCommand({
      extensionId: "tools",
      commandName: "tools",
      args: ["status", "--json"],
      stdin: (async function* () {
        yield new Uint8Array([1, 2]);
      })(),
      stdout: createTestWriter(stdout),
      stderr: createTestWriter(stderr),
      signals: new EventEmitter(),
      handler: async (args, ctx) => {
        expect(Object.isFrozen(args)).toBe(true);
        expect(ctx.cwd).toBe(process.cwd());
        for await (const chunk of ctx.stdin) {
          await ctx.stdout.write(chunk);
        }
        await ctx.stderr.write("done\n");
        return { kind: "exit", code: 7 };
      },
    });

    expect(execution).toMatchObject({
      result: { kind: "exit", code: 7 },
      stdinReadStarted: true,
      stdinConsumed: true,
      stdoutBytes: 2,
      stderrBytes: 5,
    });
    expect(stdout).toHaveLength(1);
    expect(stderr).toEqual(["done\n"]);
  });

  test("rejects stdout before delegation and revokes late writes", async () => {
    const stdout: Array<string | Uint8Array> = [];
    let leasedWriter: { write(chunk: string): Promise<void> } | undefined;

    await expect(
      runExtensionCliCommand({
        extensionId: "tools",
        commandName: "tools",
        args: [],
        stdin: (async function* () {})(),
        stdout: createTestWriter(stdout),
        stderr: createTestWriter([]),
        signals: new EventEmitter(),
        handler: async (_args, ctx) => {
          leasedWriter = ctx.stdout;
          void ctx.stdout.write("bad");
          return { kind: "delegate", argv: ["diff"] };
        },
      }),
    ).rejects.toThrow("wrote to stdout before delegating");

    await expect(leasedWriter?.write("late")).rejects.toThrow("no longer available");
  });

  test("closes output leases before draining writes accepted by the handler", async () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    let chainedWrite: Promise<void> | undefined;
    const execution = runExtensionCliCommand({
      extensionId: "tools",
      commandName: "tools",
      args: [],
      stdin: (async function* () {})(),
      stdout: createTestWriter([]),
      stderr: {
        write(_chunk, callback) {
          callbacks.push(callback);
          return true;
        },
      },
      signals: new EventEmitter(),
      handler: (_args, ctx) => {
        const first = ctx.stderr.write("first");
        void first.then(() => {
          chainedWrite = ctx.stderr.write("second");
        });
        return { kind: "delegate", argv: ["diff"] };
      },
    });

    await Promise.resolve();
    callbacks[0]?.();
    expect((await execution).result).toEqual({ kind: "delegate", argv: ["diff"] });
    await expect(chainedWrite).rejects.toThrow("no longer available");
    expect(callbacks).toHaveLength(1);
  });

  test("drains every accepted output write before reporting one failure", async () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    let settled = false;
    const execution = runExtensionCliCommand({
      extensionId: "tools",
      commandName: "tools",
      args: [],
      stdin: (async function* () {})(),
      stdout: {
        write(_chunk, callback) {
          callbacks.push(callback);
          return true;
        },
      },
      stderr: createTestWriter([]),
      signals: new EventEmitter(),
      handler: (_args, ctx) => {
        void ctx.stdout.write("first");
        void ctx.stdout.write("second");
        return { kind: "exit" };
      },
    }).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    callbacks[0]?.(new Error("first failed"));
    await Promise.resolve();
    expect(settled).toBe(false);
    callbacks[1]?.();
    await expect(execution).rejects.toThrow("first failed");
    expect(settled).toBe(true);
  });

  test("does not claim stdin merely because the handler obtains an iterator", async () => {
    const execution = await runExtensionCliCommand({
      extensionId: "tools",
      commandName: "tools",
      args: [],
      stdin: {
        [Symbol.asyncIterator]() {
          throw new Error("source iterator should stay lazy");
        },
      },
      stdout: createTestWriter([]),
      stderr: createTestWriter([]),
      signals: new EventEmitter(),
      handler: (_args, ctx) => {
        ctx.stdin[Symbol.asyncIterator]();
        return { kind: "delegate", argv: ["diff"] };
      },
    });

    expect(execution.stdinReadStarted).toBe(false);
    expect(execution.stdinConsumed).toBe(false);
  });

  test("tracks a pending stdin read before delegation", async () => {
    const execution = await runExtensionCliCommand({
      extensionId: "tools",
      commandName: "tools",
      args: [],
      stdin: {
        [Symbol.asyncIterator]() {
          let finishRead: ((result: IteratorResult<Uint8Array>) => void) | undefined;
          return {
            next: () =>
              new Promise<IteratorResult<Uint8Array>>((resolve) => {
                finishRead = resolve;
              }),
            return: async () => {
              finishRead?.({ done: true, value: undefined });
              return { done: true as const, value: undefined };
            },
          };
        },
      },
      stdout: createTestWriter([]),
      stderr: createTestWriter([]),
      signals: new EventEmitter(),
      handler: (_args, ctx) => {
        void ctx.stdin[Symbol.asyncIterator]().next();
        return { kind: "delegate", argv: ["diff", "--agent-context", "-"] };
      },
    });

    expect(execution.stdinReadStarted).toBe(true);
    expect(execution.stdinConsumed).toBe(false);
  });

  test("preserves expected user errors and rejects malformed results", async () => {
    const base = {
      extensionId: "tools",
      commandName: "tools",
      args: [],
      stdin: (async function* () {})(),
      stdout: createTestWriter([]),
      stderr: createTestWriter([]),
      signals: new EventEmitter(),
    };

    await expect(
      runExtensionCliCommand({
        ...base,
        handler: () => {
          throw new HunkExtensionUserError("Sign in first.");
        },
      }),
    ).rejects.toThrow("Sign in first.");

    await expect(
      runExtensionCliCommand({
        ...base,
        handler: () => ({ kind: "exit", code: 999 }),
      }),
    ).rejects.toThrow("exit code must be a safe integer");
  });

  test("aborts on host signals and removes listeners", async () => {
    const signals = new EventEmitter();
    const execution = runExtensionCliCommand({
      extensionId: "tools",
      commandName: "tools",
      args: [],
      stdin: (async function* () {})(),
      stdout: createTestWriter([]),
      stderr: createTestWriter([]),
      signals,
      handler: async (_args, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { kind: "exit" };
      },
    });

    signals.emit("SIGINT");
    expect((await execution).result).toEqual({ kind: "exit", code: 0 });
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
