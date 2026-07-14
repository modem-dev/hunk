import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createWatchTestClock } from "../../test/helpers/watchTest";
import { createWatchController, WATCH_EVENT_SOURCE_STARTUP_TIMEOUT_CODE } from "./watchController";
import {
  createNativeTreeWatcher,
  createWatchObserver,
  type NativeRecursiveWatchFactory,
  type WatchTreeBackend,
} from "./watchObserver";
import type { DirectoryTreeWatchTarget, WatchPlan } from "./watchPlan";

/** Build one neutral recursive target for backend and event-filter tests. */
function treeTarget(directory = "/repo"): DirectoryTreeWatchTarget {
  return {
    kind: "directory-tree",
    directory,
    ignoredRoots: [join(directory, ".git"), join(directory, "node_modules")],
    sources: ["worktree"],
  };
}

/** Build a controllable tree backend that records construction and closes. */
function fakeTreeBackend(calls: string[], name: string): WatchTreeBackend {
  return () => {
    calls.push(name);
    return {
      close() {
        calls.push(`${name}:close`);
      },
      onError() {},
      whenReady(callback) {
        queueMicrotask(callback);
      },
    };
  };
}

/** Start a tree observer with synthetic platform and injected backend choices. */
async function selectedBackend(
  platform: NodeJS.Platform,
  treeBackend: "auto" | "native" | "chokidar" = "auto",
) {
  const calls: string[] = [];
  const plan: WatchPlan = { coverage: "hybrid", targets: [treeTarget()] };
  const observer = createWatchObserver(
    plan,
    { onEvent() {}, onError() {} },
    {
      platform,
      treeBackend,
      treeBackends: {
        native: fakeTreeBackend(calls, "native"),
        portable: fakeTreeBackend(calls, "portable"),
      },
    },
  );
  await observer.ready;
  observer.close();
  await observer.closed;
  return calls;
}

describe("watch tree backend selection", () => {
  test("degrades and closes an observer whose injected backend stalls during startup", async () => {
    const testClock = createWatchTestClock();
    const plan: WatchPlan = { coverage: "hybrid", targets: [treeTarget()] };
    const errors: unknown[] = [];
    let closes = 0;
    let observer!: ReturnType<typeof createWatchObserver>;
    const stalledBackend: WatchTreeBackend = () => ({
      close() {
        closes++;
      },
      onError() {},
      whenReady() {},
    });
    const controller = createWatchController({
      initialSignature: "same",
      clock: testClock.clock,
      createEventSource(callbacks) {
        observer = createWatchObserver(plan, callbacks, {
          platform: "linux",
          treeBackends: { native: stalledBackend, portable: stalledBackend },
        });
        return observer;
      },
      getSignature: () => "same",
      refresh: () => {},
      reportError: (error) => errors.push(error),
      startupTimeoutMs: 25,
    });

    testClock.advanceBy(25);
    await observer.closed;
    expect(controller.getState().degraded).toBe(true);
    expect(closes).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: WATCH_EVENT_SOURCE_STARTUP_TIMEOUT_CODE });
    controller.close();
    expect(closes).toBe(1);
  });

  test.each(["darwin", "win32"] as const)("uses native recursion on %s", async (platform) => {
    expect(await selectedBackend(platform)).toEqual(["native", "native:close"]);
  });

  test.each(["linux", "android", "freebsd"] as const)(
    "uses portable pruned recursion on %s",
    async (platform) => {
      expect(await selectedBackend(platform)).toEqual(["portable", "portable:close"]);
    },
  );

  test("allows benchmark probes to force either tree backend", async () => {
    expect(await selectedBackend("win32", "chokidar")).toEqual(["portable", "portable:close"]);
    expect(await selectedBackend("linux", "native")).toEqual(["native", "native:close"]);
  });

  test("does not fall back to portable recursion when native construction fails", () => {
    const calls: string[] = [];
    const plan: WatchPlan = { coverage: "hybrid", targets: [treeTarget()] };

    expect(() =>
      createWatchObserver(
        plan,
        { onEvent() {}, onError() {} },
        {
          platform: "darwin",
          treeBackends: {
            native() {
              calls.push("native");
              throw new Error("native construction failed");
            },
            portable: fakeTreeBackend(calls, "portable"),
          },
        },
      ),
    ).toThrow("native construction failed");
    expect(calls).toEqual(["native"]);
  });
});

describe("native recursive tree watcher", () => {
  test("signals readiness on a microtask after construction", async () => {
    const order: string[] = [];
    const watcher = createNativeTreeWatcher(
      treeTarget(),
      () => {},
      () => {
        order.push("constructed");
        return { close() {}, onError() {} };
      },
    );

    watcher.whenReady(() => order.push("ready"));
    order.push("synchronous");
    expect(order).toEqual(["constructed", "synchronous"]);
    await Promise.resolve();
    expect(order).toEqual(["constructed", "synchronous", "ready"]);
  });

  test("suppresses trustworthy paths inside ignored roots", () => {
    let emit!: (filename: string | Buffer | null) => void;
    let events = 0;
    const factory: NativeRecursiveWatchFactory = (_directory, onChange) => {
      emit = onChange;
      return { close() {}, onError() {} };
    };
    createNativeTreeWatcher(treeTarget(), () => events++, factory);

    emit(join("node_modules", "package", "index.js"));
    emit(join(".git", "objects", "pack", "data"));
    emit(join("src", "index.ts"));

    expect(events).toBe(1);
  });

  test("conservatively emits for missing and ambiguous filenames", () => {
    let emit!: (filename: string | Buffer | null) => void;
    let events = 0;
    createNativeTreeWatcher(
      treeTarget(),
      () => events++,
      (_directory, onChange) => {
        emit = onChange;
        return { close() {}, onError() {} };
      },
    );

    emit(null);
    emit("");
    emit("index.js");
    emit(Buffer.from("index.js"));

    expect(events).toBe(4);
  });

  test("forwards errors and releases its native handle", () => {
    let reportError!: (error: unknown) => void;
    let closes = 0;
    const watcher = createNativeTreeWatcher(
      treeTarget(),
      () => {},
      () => ({
        close() {
          closes++;
        },
        onError(callback) {
          reportError = callback;
        },
      }),
    );
    const errors: unknown[] = [];
    watcher.onError((error) => errors.push(error));

    const error = new Error("native watcher failed");
    reportError(error);
    watcher.close();

    expect(errors).toEqual([error]);
    expect(closes).toBe(1);
  });
});
