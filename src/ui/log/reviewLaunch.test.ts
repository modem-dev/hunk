import { describe, expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { HistoryRuntime } from "../history/types";
import { prepareHistoryReview } from "./reviewLaunch";

/** Provide the launch fields used by the process adapter without constructing a repository cursor. */
function createTestRuntime() {
  return {
    repoRoot: "/repo",
    providerId: "opaque-vcs",
    input: { extensionPaths: [], extensionsEnabled: false },
  } as unknown as HistoryRuntime;
}

/** Emulate the bounded ChildProcess surface used by the handoff orchestration. */
function createTestChild({ ignoreTerm = false }: { ignoreTerm?: boolean } = {}) {
  const child = new EventEmitter() as ChildProcess & {
    sent: unknown[];
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    connected: boolean;
  };
  child.sent = [];
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;
  child.stderr = new PassThrough();
  child.send = ((message: unknown, callback?: (error: Error | null) => void) => {
    child.sent.push(message);
    callback?.(null);
    return true;
  }) as ChildProcess["send"];
  child.kill = ((signal: NodeJS.Signals = "SIGTERM") => {
    if (signal === "SIGTERM" && ignoreTerm) return true;
    child.signalCode = signal;
    child.connected = false;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  }) as ChildProcess["kill"];
  return child;
}

describe("history review readiness", () => {
  test("does not release terminal ownership until the child reports ready", async () => {
    const child = createTestChild();
    const preparedPromise = prepareHistoryReview(
      createTestRuntime(),
      { kind: "revision-show", revisionId: "opaque:id" },
      {
        current: { command: "hunk", args: [] },
        spawnImpl: (() => child) as unknown as typeof spawn,
        env: {},
      },
    );

    expect(child.sent).toEqual([]);
    child.emit("message", { protocol: "hunk-terminal-handoff-v1", kind: "ready" });
    const prepared = await preparedPromise;
    expect(child.sent).toEqual([]);

    const exit = prepared.run();
    expect(child.sent).toEqual([{ protocol: "hunk-terminal-handoff-v1", kind: "release" }]);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    expect(await exit).toBe(0);
  });

  test("observes a signalled exit that happens after readiness but before run", async () => {
    const child = createTestChild();
    const preparedPromise = prepareHistoryReview(
      createTestRuntime(),
      { kind: "revision-show", revisionId: "racy" },
      {
        current: { command: "hunk", args: [] },
        spawnImpl: (() => child) as unknown as typeof spawn,
        env: {},
      },
    );

    child.emit("message", { protocol: "hunk-terminal-handoff-v1", kind: "ready" });
    const prepared = await preparedPromise;
    child.signalCode = "SIGTERM";
    child.connected = false;
    child.emit("exit", null, "SIGTERM");
    expect(await prepared.run()).toBe(1);
  });

  test("surfaces bounded child bootstrap failures without releasing the terminal", async () => {
    const child = createTestChild();
    const prepared = prepareHistoryReview(
      createTestRuntime(),
      { kind: "revision-show", revisionId: "missing" },
      {
        current: { command: "hunk", args: [] },
        spawnImpl: (() => child) as unknown as typeof spawn,
        env: {},
      },
    );
    child.emit("message", {
      protocol: "hunk-terminal-handoff-v1",
      kind: "failed",
      message: "provider could not resolve revision",
    });
    await expect(prepared).rejects.toThrow("provider could not resolve revision");
    expect(child.sent).toEqual([]);
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("escalates when a timed-out child ignores graceful termination", async () => {
    const child = createTestChild({ ignoreTerm: true });
    const prepared = prepareHistoryReview(
      createTestRuntime(),
      { kind: "revision-show", revisionId: "slow" },
      {
        current: { command: "hunk", args: [] },
        spawnImpl: (() => child) as unknown as typeof spawn,
        env: {},
        readyTimeoutMs: 5,
        terminateGraceMs: 5,
      },
    );
    await expect(prepared).rejects.toThrow("Timed out while preparing");
    expect(child.signalCode).toBe("SIGKILL");
  });
});
