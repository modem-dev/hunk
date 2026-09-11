import { expect, mock, test } from "bun:test";
import { createTestStatusRuntime } from "../../../../../test/helpers/status-runtime";
import { StatusController } from "./controller";
import { createWatchController } from "../../core/watch/controller";

/** Hold one async provider response until a test explicitly releases it. */
function createTestDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("current refresh remains independent while same-target siblings progress and merge only their facts", async () => {
  const runtime = createTestStatusRuntime();
  const first = createTestDeferred<typeof runtime.snapshot>();
  const second = createTestDeferred<typeof runtime.snapshot>();
  const signals: AbortSignal[] = [];
  runtime.loadSiblings = mock(async (_snapshot, signal) => {
    signals.push(signal!);
    return signals.length === 1 ? first.promise : second.promise;
  });
  const controller = new StatusController(runtime);
  controller.select("path:beta.ts", 1);
  controller.resume();
  await Bun.sleep(0);
  expect(signals).toHaveLength(1);
  runtime.load = async () => ({
    ...runtime.snapshot,
    changedPathCount: 3,
    paths: [...runtime.snapshot.paths].reverse(),
  });
  await controller.refresh();
  expect(signals[0]!.aborted).toBe(false);
  expect(signals).toHaveLength(1);
  expect(controller.getSnapshot().snapshot.changedPathCount).toBe(3);
  expect(controller.getSnapshot().siblingsLoading).toBe(true);
  expect(controller.getSnapshot().selected).toBe("path:beta.ts");
  expect(controller.getSnapshot().snapshot.paths.map((path) => path.path)).toEqual([
    "alpha.ts",
    "beta.ts",
  ]);
  first.resolve({
    ...runtime.snapshot,
    changedPathCount: 999,
    siblings: { state: "error", message: "first scan" },
  });
  await Bun.sleep(0);
  expect(controller.getSnapshot().snapshot.changedPathCount).toBe(3);
  expect(controller.getSnapshot().snapshot.siblings).toEqual({
    state: "error",
    message: "first scan",
  });
  await controller.refresh();
  expect(signals).toHaveLength(2);
  second.resolve({
    ...runtime.snapshot,
    changedPathCount: 888,
    siblings: { state: "error", message: "current sibling error" },
  });
  await Bun.sleep(0);
  expect(controller.getSnapshot().snapshot.changedPathCount).toBe(3);
  expect(controller.getSnapshot().snapshot.siblings).toEqual({
    state: "error",
    message: "current sibling error",
  });
  expect(controller.getSnapshot().siblingsLoading).toBe(false);
  await controller.close();
});

test("suspension drains cancelled sibling scans and never publishes after target change or quit", async () => {
  const runtime = createTestStatusRuntime();
  const late = createTestDeferred<typeof runtime.snapshot>();
  let signal: AbortSignal | undefined;
  runtime.loadSiblings = async (_snapshot, active) => {
    signal = active;
    return late.promise;
  };
  const controller = new StatusController(runtime);
  controller.resume();
  await Bun.sleep(0);
  let drained = false;
  const inspecting = controller.inspect("sibling-target").then(() => {
    drained = true;
  });
  await Bun.sleep(0);
  expect(signal!.aborted).toBe(true);
  expect(drained).toBe(false);
  runtime.loadSiblings = async (snapshot) => snapshot;
  late.resolve({ ...runtime.snapshot, changedPathCount: 999 });
  await inspecting;
  await controller.refresh();
  expect(controller.getSnapshot().snapshot.worktree.path).toBe("sibling-target");
  expect(controller.getSnapshot().snapshot.changedPathCount).toBe(2);
  await controller.close();
  expect(controller.getSnapshot().snapshot.changedPathCount).toBe(2);
});

test("inspects and returns within retained status navigation without changing cwd or extension authority", async () => {
  const runtime = createTestStatusRuntime();
  const controller = new StatusController(runtime);
  const cwd = process.cwd();
  const authority = runtime.extensionSession.current;
  controller.resume();
  await controller.refresh();
  controller.select("path:beta.ts", 2);
  controller.toggleWorktrees();
  await controller.inspect("sibling-target");
  expect(controller.getSnapshot().snapshot.worktree.path).toBe("sibling-target");
  expect(controller.getSnapshot().backPath).toBe(runtime.snapshot.worktree.path);
  await controller.back();
  await controller.refresh();
  expect(controller.getSnapshot()).toMatchObject({
    selected: "path:beta.ts",
    expandedWorktrees: true,
    top: 2,
  });
  expect(process.cwd()).toBe(cwd);
  expect(runtime.extensionSession.current).toBe(authority);
  await controller.close();
});

test("suspends and closes watchers, cancels stale reads and never publishes after shutdown", async () => {
  const runtime = createTestStatusRuntime();
  const late = createTestDeferred<typeof runtime.snapshot>();
  runtime.watchPlan = async () => ({ coverage: "hybrid", targets: [] });
  const close = mock(() => undefined);
  const controller = new StatusController(runtime, {
    createObserver: (_plan, callbacks) => {
      callbacks.onReady?.();
      return { close, ready: Promise.resolve(), closed: Promise.resolve() };
    },
  });
  controller.resume();
  await controller.refresh();
  await Bun.sleep(0);
  runtime.load = async () => late.promise;
  void controller.refresh();
  const before = controller.getSnapshot().snapshot;
  const closing = controller.close();
  late.resolve({ ...runtime.snapshot, changedPathCount: 999 });
  await closing;
  expect(close).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().snapshot).toBe(before);
  controller.resume();
  await controller.refresh();
  expect(controller.getSnapshot().snapshot).toBe(before);
});

test("keeps failed target inspection and refresh usable with explicit stale errors", async () => {
  const runtime = createTestStatusRuntime();
  const controller = new StatusController(runtime);
  controller.resume();
  await controller.refresh();
  runtime.load = async () => {
    throw new Error("Worktree removed");
  };
  await controller.inspect("removed");
  await controller.refresh();
  expect(controller.getSnapshot().snapshot.worktree.path).toBe(runtime.snapshot.worktree.path);
  expect(controller.getSnapshot().notice).toContain("Worktree removed");
  expect(controller.getSnapshot().loading).toBe(false);
  await controller.close();
});

test("burst current refreshes coalesce independently and quit drains a cancelled secondary scan", async () => {
  const runtime = createTestStatusRuntime();
  const current = createTestDeferred<typeof runtime.snapshot>();
  const sibling = createTestDeferred<typeof runtime.snapshot>();
  let reads = 0;
  let siblingSignal: AbortSignal | undefined;
  runtime.load = async () => (++reads === 1 ? current.promise : runtime.snapshot);
  runtime.loadSiblings = mock(async (_snapshot, signal) => {
    siblingSignal = signal;
    return sibling.promise;
  });
  const controller = new StatusController(runtime);
  controller.resume();
  const refresh = controller.refresh();
  void controller.refresh();
  current.resolve(runtime.snapshot);
  await refresh;
  expect(reads).toBe(2);
  expect(runtime.loadSiblings).toHaveBeenCalledTimes(1);
  const before = controller.getSnapshot().snapshot;
  let closed = false;
  const closing = controller.close().then(() => {
    closed = true;
  });
  await Bun.sleep(0);
  expect(siblingSignal!.aborted).toBe(true);
  expect(closed).toBe(false);
  sibling.resolve({ ...runtime.snapshot, changedPathCount: 999 });
  await closing;
  expect(controller.getSnapshot().snapshot).toBe(before);
});

for (const coverage of ["poll-only", "hybrid"] as const) {
  test(`real ${coverage} safety timers publish slow siblings repeatedly despite changing observation tokens`, async () => {
    const runtime = createTestStatusRuntime();
    let reads = 0;
    let scans = 0;
    let completed = 0;
    let cancelled = 0;
    if (runtime.snapshot.siblings.state !== "ready") throw new Error("Missing test sibling");
    const sibling = runtime.snapshot.siblings.value.worktrees[0]!;
    runtime.watchPlan = async () => ({ coverage, targets: [] });
    runtime.load = async () => ({
      ...runtime.snapshot,
      token: `current-${++reads}`,
      observedAt: new Date().toISOString(),
      siblings: { state: "loading" },
    });
    runtime.loadSiblings = async (snapshot, signal) => {
      const scan = ++scans;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          cancelled++;
          clearTimeout(timer);
          reject(signal!.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 140);
        signal?.addEventListener("abort", abort, { once: true });
      });
      completed++;
      return {
        ...snapshot,
        siblings: {
          state: "ready",
          value: {
            worktrees: [
              {
                ...sibling,
                status: { state: "error", message: `scan-${scan}` },
              },
            ],
            truncated: false,
          },
        },
      };
    };
    const controller = new StatusController(runtime, {
      createWatch: (options) =>
        createWatchController({ ...options, healthyCheckMs: 20, degradedCheckMs: 20 }),
      createObserver: (_plan, callbacks) => {
        callbacks.onReady?.();
        return { close() {}, ready: Promise.resolve(), closed: Promise.resolve() };
      },
    });
    try {
      controller.resume();
      const deadline = Date.now() + 2500;
      while (completed < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(completed).toBeGreaterThanOrEqual(2);
      expect(reads).toBeGreaterThanOrEqual(4);
      expect(cancelled).toBe(0);
      const snapshot = controller.getSnapshot().snapshot;
      expect(snapshot.token).toBe(`current-${reads}`);
      expect(snapshot.siblings.state).toBe("ready");
      if (snapshot.siblings.state === "ready")
        expect(snapshot.siblings.value.worktrees[0]!.status).toEqual({
          state: "error",
          message: "scan-2",
        });
      expect(scans).toBeLessThanOrEqual(completed + 1);
    } finally {
      await controller.close();
    }
    const finalReads = reads;
    const finalScans = scans;
    await Bun.sleep(50);
    expect(reads).toBe(finalReads);
    expect(scans).toBe(finalScans);
  });
}

test("independent group expansion survives refresh, child suspension and sibling inspect/back", async () => {
  const runtime = createTestStatusRuntime();
  runtime.snapshot.paths = Array.from({ length: 25 }, (_, i) => ({
    path: `file-${i}`,
    index: "unchanged",
    worktree: "modified",
    conflict: false,
  }));
  const controller = new StatusController(runtime);
  try {
    controller.resume();
    await controller.refresh();
    controller.togglePathGroup("tracked");
    controller.select("path:file-24", 20);
    await controller.refresh();
    await controller.suspend();
    controller.resume();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      expandedPathGroups: { tracked: true, untracked: false },
      selected: "path:file-24",
      top: 20,
    });
    await controller.inspect("sibling-target");
    controller.togglePathGroup("untracked");
    controller.togglePathGroup("tracked");
    await controller.back();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      expandedPathGroups: { tracked: true, untracked: false },
      selected: "path:file-24",
      top: 20,
    });
    controller.togglePathGroup("tracked");
    expect(controller.getSnapshot().selected).toBe("toggle:tracked");
  } finally {
    await controller.close();
  }
});
