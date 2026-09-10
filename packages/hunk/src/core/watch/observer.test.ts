import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FSWatcher, type ChokidarOptions } from "chokidar";

import { createWatchTestClock } from "../../../../../test/helpers/watchTest";
import { createWatchController, WATCH_EVENT_SOURCE_STARTUP_TIMEOUT_CODE } from "./controller";
import {
  createNativeTreeWatcher,
  createWatchObserver,
  type NativeRecursiveWatchFactory,
  type WatchTreeBackend,
} from "./observer";
import type { DirectoryTreeWatchTarget, WatchPlan } from "./plan";
import {
  createChunkedTreeWatcher,
  PORTABLE_TREE_BATCH_SIZE,
  type PortableTreeRuntime,
} from "./portableTree";

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
async function selectedBackend(platform: NodeJS.Platform) {
  const calls: string[] = [];
  const plan: WatchPlan = { coverage: "hybrid", targets: [treeTarget()] };
  const observer = createWatchObserver(
    plan,
    { onEvent() {}, onError() {} },
    {
      platform,
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

  test("cached ancestor decisions preserve ignored boundaries after bounded-cache eviction", () => {
    const directory = resolve("watch-test-root");
    let emit!: (filename: string | Buffer | null) => void;
    let events = 0;
    const source = createNativeTreeWatcher(
      { ...treeTarget(directory), ignoredRoots: [join(directory, "src", "ignored")] },
      () => events++,
      (_directory, onChange) => {
        emit = onChange;
        return { close() {}, onError() {} };
      },
    );
    for (let index = 0; index < 8_200; index++) emit(join("src", `file-${index}.ts`));
    emit(join("src", "ignored", "file.ts"));
    emit(join("src", "ignored-sibling", "file.ts"));
    expect(events).toBe(8_201);
    source.close();
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

/** Drain the bounded promise chain of one batch without advancing its admission timer. */
async function settleTestBatch() {
  for (let index = 0; index < 24; index++) await Promise.resolve();
}

/** Control public Chokidar events, directory reads, and individual admission macrotasks. */
function createTestPortableTree() {
  const root = resolve("watch-test-root");
  const directories = new Map<string, string[]>();
  const tasks = new Set<() => void>();
  const batches: Array<{
    paths: string[];
    watcher: FSWatcher;
    options?: ChokidarOptions;
    closes: number;
  }> = [];
  const reads: string[] = [];
  const runtime: PortableTreeRuntime = {
    watch(paths, options) {
      // Empty FSWatcher instances exercise only public events and never register real paths.
      const watcher = new FSWatcher(options);
      const batch = {
        paths: typeof paths === "string" ? [paths] : paths,
        watcher,
        options,
        closes: 0,
      };
      const close = watcher.close.bind(watcher);
      watcher.close = () => {
        batch.closes++;
        return close();
      };
      batches.push(batch);
      return watcher;
    },
    async readDirectories(path) {
      reads.push(path);
      return directories.get(path) ?? [];
    },
    schedule(callback) {
      tasks.add(callback);
      return () => {
        tasks.delete(callback);
      };
    },
  };
  return {
    root,
    directories,
    tasks,
    batches,
    reads,
    runtime,
    async advanceBatch() {
      const callback = tasks.values().next().value;
      if (!callback) throw new Error("No queued test batch");
      tasks.delete(callback);
      callback();
      await settleTestBatch();
    },
    async ready(index: number) {
      batches[index]!.watcher.emit("ready");
      await settleTestBatch();
    },
  };
}

describe("portable tree batches", () => {
  test("yields between bounded shallow batches and reports ready only after nested discovery", async () => {
    const fixture = createTestPortableTree();
    const children = Array.from({ length: PORTABLE_TREE_BATCH_SIZE + 1 }, (_, index) =>
      join(fixture.root, `d${index}`),
    );
    const nested = join(children[0]!, "nested");
    const ignored = join(fixture.root, "ignored");
    fixture.directories.set(fixture.root, [...children, ignored]);
    fixture.directories.set(children[0]!, [nested]);
    let ready = 0;
    let progress = 0;
    const source = createChunkedTreeWatcher(
      fixture.root,
      (path) => path === ignored,
      () => {},
      fixture.runtime,
    );
    source.whenReady(() => ready++);
    source.onProgress(() => progress++);
    try {
      expect(fixture.batches).toHaveLength(0);
      await fixture.advanceBatch();
      expect(fixture.batches[0]!.paths).toEqual([fixture.root]);
      expect(fixture.batches[0]!.options).toMatchObject({
        depth: 0,
        followSymlinks: false,
        ignoreInitial: true,
      });
      await fixture.ready(0);
      expect(progress).toBe(1);
      expect(ready).toBe(0);
      expect(fixture.batches).toHaveLength(1);
      await fixture.advanceBatch();
      expect(fixture.batches[1]!.paths).toEqual(children.slice(0, PORTABLE_TREE_BATCH_SIZE));
      await fixture.ready(1);
      expect(ready).toBe(0);
      await fixture.advanceBatch();
      expect(fixture.batches[2]!.paths).toEqual([children.at(-1)!, nested]);
      await fixture.ready(2);
      expect(ready).toBe(1);
      expect(progress).toBe(3);
      expect(fixture.tasks.size).toBe(0);
      expect(fixture.reads).not.toContain(ignored);
    } finally {
      await source.close();
    }
    expect(fixture.batches.map((batch) => batch.closes)).toEqual([1, 1, 1]);
  });

  test("a wholly ignored root reaches ready without creating a watcher", async () => {
    const fixture = createTestPortableTree();
    let ready = 0;
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => true,
      () => {},
      fixture.runtime,
    );
    source.whenReady(() => ready++);
    await fixture.advanceBatch();
    expect(ready).toBe(1);
    expect(fixture.batches).toHaveLength(0);
    expect(fixture.reads).toHaveLength(0);
    await source.close();
    source.whenReady(() => ready++);
    await settleTestBatch();
    expect(ready).toBe(1);
  });

  test("close cancels queued admission before any watcher exists", async () => {
    const fixture = createTestPortableTree();
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => false,
      () => {},
      fixture.runtime,
    );
    const closing = source.close();
    expect(source.close()).toBe(closing);
    await closing;
    expect(fixture.tasks.size).toBe(0);
    expect(fixture.batches).toHaveLength(0);
  });

  test("close settles a drain awaiting batch ready and suppresses late callbacks", async () => {
    const fixture = createTestPortableTree();
    let callbacks = 0;
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => false,
      () => callbacks++,
      fixture.runtime,
    );
    source.whenReady(() => callbacks++);
    source.onProgress(() => callbacks++);
    await fixture.advanceBatch();
    const watcher = fixture.batches[0]!.watcher;
    expect(watcher.listenerCount("ready")).toBe(1);
    await source.close();
    watcher.emit("ready");
    watcher.emit("all", "addDir", join(fixture.root, "late"));
    await settleTestBatch();
    expect(watcher.listenerCount("ready")).toBe(0);
    expect(callbacks).toBe(0);
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.tasks.size).toBe(0);
    expect(fixture.batches[0]!.closes).toBe(1);
  });

  test("close does not wait for an outstanding directory read or admit its late children", async () => {
    const fixture = createTestPortableTree();
    let finishRead!: (children: string[]) => void;
    fixture.runtime.readDirectories = () =>
      new Promise((resolveRead) => {
        finishRead = resolveRead;
      });
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => false,
      () => {},
      fixture.runtime,
    );
    await fixture.advanceBatch();
    await fixture.ready(0);
    await source.close();
    finishRead([join(fixture.root, "late")]);
    await settleTestBatch();
    expect(fixture.tasks.size).toBe(0);
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.batches[0]!.closes).toBe(1);
  });

  test("an enumeration error is reported without stranding final readiness", async () => {
    const fixture = createTestPortableTree();
    const error = Object.assign(new Error("read failed"), { code: "EACCES" });
    fixture.runtime.readDirectories = async () => {
      throw error;
    };
    const errors: unknown[] = [];
    let ready = 0;
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => false,
      () => {},
      fixture.runtime,
    );
    source.onError((error) => errors.push(error));
    source.whenReady(() => ready++);
    await fixture.advanceBatch();
    await fixture.ready(0);
    expect(errors).toEqual([error]);
    expect(ready).toBe(1);
    await source.close();
  });

  test.each(["ENOSPC", "EMFILE", "EACCES"])(
    "a mid-batch %s error reaches polling fallback and cancels the drain",
    async (code) => {
      const fixture = createTestPortableTree();
      const clock = createWatchTestClock();
      let source!: ReturnType<typeof createChunkedTreeWatcher>;
      let observer!: ReturnType<typeof createWatchObserver>;
      const backend: WatchTreeBackend = (_target, onEvent) => {
        source = createChunkedTreeWatcher(fixture.root, () => false, onEvent, fixture.runtime);
        return source;
      };
      const errors: unknown[] = [];
      const controller = createWatchController({
        initialSignature: "same",
        getSignature: () => "same",
        refresh() {},
        clock: clock.clock,
        reportError: (error) => errors.push(error),
        createEventSource(callbacks) {
          observer = createWatchObserver(
            { coverage: "hybrid", targets: [treeTarget(fixture.root)] },
            callbacks,
            { platform: "linux", treeBackends: { native: backend, portable: backend } },
          );
          return observer;
        },
      });
      await fixture.advanceBatch();
      fixture.batches[0]!.watcher.emit("error", Object.assign(new Error("watch failed"), { code }));
      // Non-resource errors retain the no-progress deadline rather than declaring partial ready.
      if (code === "EACCES") {
        expect(controller.getState().degraded).toBe(false);
        clock.advanceBy(2_000);
      }
      await observer.closed;
      await source.close();
      expect(controller.getState().degraded).toBe(true);
      expect(fixture.batches[0]!.closes).toBe(1);
      expect(fixture.tasks.size).toBe(0);
      expect(errors[0]).toMatchObject({ code });
      controller.close();
    },
  );

  test("runtime addDir duplicates share one admission and removed batches can be recreated", async () => {
    const fixture = createTestPortableTree();
    let events = 0;
    let ready = 0;
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => false,
      () => events++,
      fixture.runtime,
    );
    source.whenReady(() => ready++);
    await fixture.advanceBatch();
    await fixture.ready(0);
    const parent = fixture.batches[0]!.watcher;
    const child = join(fixture.root, "new");
    parent.emit("all", "addDir", child);
    parent.emit("all", "addDir", child);
    await fixture.advanceBatch();
    expect(fixture.batches[1]!.paths).toEqual([child]);
    parent.emit("all", "addDir", child);
    await fixture.ready(1);
    expect(fixture.batches).toHaveLength(2);
    expect(fixture.tasks.size).toBe(0);
    expect(events).toBe(5); // Three events, one new admission, and the population-race hint.
    expect(ready).toBe(1);
    fixture.batches[1]!.watcher.emit("all", "unlinkDir", child);
    await settleTestBatch();
    expect(fixture.batches[1]!.closes).toBe(1);
    parent.emit("all", "addDir", child);
    await fixture.advanceBatch();
    await fixture.ready(2);
    expect(fixture.batches[2]!.paths).toEqual([child]);
    await source.close();
    expect(fixture.batches.map((batch) => batch.closes)).toEqual([1, 1, 1]);
  });

  test.each(["parent", "owner"] as const)(
    "%s unlinkDir invalidates descendant batches and queued children without reusing stale owners",
    async (origin) => {
      const fixture = createTestPortableTree();
      const child = join(fixture.root, "a");
      const nested = join(child, "b");
      const queued = join(nested, "queued");
      const sibling = join(fixture.root, "ab");
      fixture.directories.set(fixture.root, [child, sibling]);
      fixture.directories.set(child, [nested]);
      let events = 0;
      const source = createChunkedTreeWatcher(
        fixture.root,
        () => false,
        () => events++,
        fixture.runtime,
      );
      try {
        await fixture.advanceBatch();
        await fixture.ready(0);
        await fixture.advanceBatch();
        await fixture.ready(1);
        await fixture.advanceBatch();
        await fixture.ready(2);
        fixture.batches[2]!.watcher.emit("all", "addDir", queued);
        // No descendant unlinkDir events are required to invalidate their ownership.
        fixture.batches[origin === "parent" ? 0 : 1]!.watcher.emit("all", "unlinkDir", child);
        await settleTestBatch();
        expect(fixture.batches.map((batch) => batch.closes)).toEqual([0, 1, 1]);
        const afterRemoval = events;
        fixture.batches[2]!.watcher.emit("all", "addDir", queued);
        const retiredFilter = fixture.batches[2]!.options!.ignored;
        if (typeof retiredFilter !== "function") throw new Error("Expected an ignored predicate");
        expect(retiredFilter(queued, statSync(process.cwd()))).toBe(true);
        expect(events).toBe(afterRemoval);
        await fixture.advanceBatch();
        expect(fixture.batches[3]!.paths).toEqual([sibling]);
        await fixture.ready(3);
        fixture.batches[0]!.watcher.emit("all", "addDir", child);
        fixture.batches[0]!.watcher.emit("all", "addDir", child);
        await fixture.advanceBatch();
        expect(fixture.batches[4]!.paths).toEqual([child]);
        await fixture.ready(4);
        await fixture.advanceBatch();
        expect(fixture.batches[5]!.paths).toEqual([nested]);
        await fixture.ready(5);
        expect(fixture.tasks.size).toBe(0);
      } finally {
        await source.close();
      }
      expect(fixture.batches.every((batch) => batch.closes === 1)).toBe(true);
    },
  );

  test("a removed anchor discovers the replacement root without owning its new inode", async () => {
    const fixture = createTestPortableTree();
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => false,
      () => {},
      fixture.runtime,
    );
    try {
      await fixture.advanceBatch();
      await fixture.ready(0);
      const anchor = fixture.batches[0]!;
      anchor.watcher.emit("all", "unlinkDir", fixture.root);
      const filter = anchor.options!.ignored;
      if (typeof filter !== "function") throw new Error("Expected an ignored predicate");
      expect(filter(fixture.root, statSync(process.cwd()))).toBe(true);
      anchor.watcher.emit("all", "addDir", fixture.root);
      await fixture.advanceBatch();
      await fixture.ready(1);
      expect(fixture.batches[1]!.paths).toEqual([fixture.root]);
      expect(filter(fixture.root, statSync(process.cwd()))).toBe(true);
      expect(fixture.tasks.size).toBe(0);
      expect(anchor.closes).toBe(0);
    } finally {
      await source.close();
    }
    expect(fixture.batches.map((batch) => batch.closes)).toEqual([1, 1]);
  });

  test("subtree invalidation discards an outstanding enumeration's late children", async () => {
    const fixture = createTestPortableTree();
    const child = join(fixture.root, "a");
    let finishRead!: (children: string[]) => void;
    fixture.runtime.readDirectories = async (path) =>
      path === fixture.root
        ? [child]
        : new Promise((resolveRead) => {
            finishRead = resolveRead;
          });
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => false,
      () => {},
      fixture.runtime,
    );
    try {
      await fixture.advanceBatch();
      await fixture.ready(0);
      await fixture.advanceBatch();
      await fixture.ready(1);
      fixture.batches[0]!.watcher.emit("all", "unlinkDir", child);
      finishRead([join(child, "late")]);
      await settleTestBatch();
      expect(fixture.tasks.size).toBe(0);
      expect(fixture.batches[1]!.closes).toBe(1);
    } finally {
      await source.close();
    }
  });

  test("the public directory filter queues runtime children once without admitting ignored or outside paths", async () => {
    const fixture = createTestPortableTree();
    const ignored = join(fixture.root, "ignored");
    let events = 0;
    const source = createChunkedTreeWatcher(
      fixture.root,
      (path) => path === ignored,
      () => events++,
      fixture.runtime,
    );
    await fixture.advanceBatch();
    await fixture.ready(0);
    const filter = fixture.batches[0]!.options!.ignored;
    if (typeof filter !== "function") throw new Error("Expected a public ignored predicate");
    const stats = statSync(process.cwd());
    const child = join(fixture.root, "new");
    expect(filter(child, stats)).toBe(false);
    expect(filter(child, stats)).toBe(false);
    expect(filter(ignored, stats)).toBe(true);
    // Missing-root fallback can inspect its parent, but must never recursively queue it.
    expect(filter(dirname(fixture.root), stats)).toBe(false);
    fixture.batches[0]!.watcher.emit("all", "addDir", dirname(fixture.root));
    expect(fixture.tasks.size).toBe(1);
    expect(events).toBe(2);
    await fixture.advanceBatch();
    expect(fixture.batches[1]!.paths).toEqual([child]);
    await fixture.ready(1);
    await source.close();
  });

  test("removing a batch before ready unblocks its drain and releases it once", async () => {
    const fixture = createTestPortableTree();
    fixture.runtime.readDirectories = async () => {
      throw Object.assign(new Error("removed"), { code: "ENOENT" });
    };
    let ready = 0;
    const source = createChunkedTreeWatcher(
      fixture.root,
      () => false,
      () => {},
      fixture.runtime,
    );
    source.onError(() => {});
    source.whenReady(() => ready++);
    await fixture.advanceBatch();
    fixture.batches[0]!.watcher.emit("all", "unlinkDir", fixture.root);
    await settleTestBatch();
    expect(ready).toBe(1);
    await source.close();
    expect(fixture.batches[0]!.closes).toBe(1);
  });
});
