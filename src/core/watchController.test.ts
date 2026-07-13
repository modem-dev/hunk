import { describe, expect, test } from "bun:test";

import {
  createWatchController,
  type WatchControllerClock,
  type WatchEventSourceCallbacks,
} from "./watchController";

class FakeWatchClock implements WatchControllerClock {
  nowMs = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();
  scheduledDelays: number[] = [];

  /** Return deterministic virtual time. */
  now() {
    return this.nowMs;
  }

  /** Record one virtual timeout. */
  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.scheduledDelays.push(delayMs);
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  }

  /** Cancel one virtual timeout. */
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }

  /** Advance through every timeout due in the requested interval. */
  advance(ms: number) {
    const target = this.nowMs + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      this.nowMs = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.nowMs = target;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Create an externally controlled promise for backpressure tests. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the bounded promise chain used by one controller transition. */
async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

/** Capture a backend-neutral event source's callbacks. */
function fakeSource() {
  let callbacks!: WatchEventSourceCallbacks;
  let closes = 0;
  return {
    create(nextCallbacks: WatchEventSourceCallbacks) {
      callbacks = nextCallbacks;
      return { close: () => closes++ };
    },
    event() {
      callbacks.onEvent();
    },
    error(error: unknown) {
      callbacks.onError(error);
    },
    ready() {
      callbacks.onReady?.();
    },
    get closes() {
      return closes;
    },
  };
}

describe("createWatchController", () => {
  test("debounces a hint without installing a 250 ms recurring timer", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    let checks = 0;
    createWatchController({
      initialSignature: "same",
      clock,
      createEventSource: source.create,
      getSignature: () => {
        checks++;
        return "same";
      },
      refresh: () => {},
    });

    source.event();
    clock.advance(199);
    expect(checks).toBe(0);
    clock.advance(1);
    await settle();
    expect(checks).toBe(1);
    expect(clock.scheduledDelays).not.toContain(250);
  });

  test("uses signatures to distinguish changed and unchanged hints", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    const signatures = ["same", "changed"];
    let refreshes = 0;
    const controller = createWatchController({
      initialSignature: "same",
      clock,
      createEventSource: source.create,
      getSignature: () => signatures.shift()!,
      refresh: () => {
        refreshes++;
      },
    });

    source.event();
    clock.advance(200);
    await settle();
    source.event();
    clock.advance(200);
    await settle();
    expect(refreshes).toBe(1);
    expect(controller.getState().appliedSignature).toBe("changed");
  });

  test("coalesces an event burst behind the quiet debounce", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    let checks = 0;
    createWatchController({
      initialSignature: "same",
      clock,
      createEventSource: source.create,
      getSignature: () => (++checks, "same"),
      refresh: () => {},
    });

    source.event();
    clock.advance(100);
    source.event();
    clock.advance(100);
    source.event();
    clock.advance(199);
    expect(checks).toBe(0);
    clock.advance(1);
    await settle();
    expect(checks).toBe(1);
  });

  test("forces continuous event noise to progress at the maximum delay", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    let checks = 0;
    createWatchController({
      initialSignature: "same",
      clock,
      createEventSource: source.create,
      getSignature: () => (++checks, "same"),
      refresh: () => {},
    });

    source.event();
    for (let elapsed = 100; elapsed < 1_000; elapsed += 100) {
      clock.advance(100);
      source.event();
    }
    clock.advance(100);
    await settle();
    expect(checks).toBe(1);
  });

  test("serializes refreshes and performs one changed trailing check", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    const firstRefresh = deferred<void>();
    const signatures = ["one", "two"];
    let activeRefreshes = 0;
    let maximumRefreshes = 0;
    let refreshes = 0;
    createWatchController({
      initialSignature: "zero",
      clock,
      createEventSource: source.create,
      getSignature: () => signatures.shift()!,
      refresh: async () => {
        refreshes++;
        activeRefreshes++;
        maximumRefreshes = Math.max(maximumRefreshes, activeRefreshes);
        if (refreshes === 1) await firstRefresh.promise;
        activeRefreshes--;
      },
    });

    source.event();
    clock.advance(200);
    await settle();
    source.event();
    source.event();
    firstRefresh.resolve();
    await settle();
    expect(refreshes).toBe(2);
    expect(maximumRefreshes).toBe(1);
  });

  test("coalesces multiple refresh-time events into one unchanged trailing check", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    const pending = deferred<void>();
    const signatures = ["changed", "changed"];
    let checks = 0;
    let refreshes = 0;
    createWatchController({
      initialSignature: "old",
      clock,
      createEventSource: source.create,
      getSignature: () => (++checks, signatures.shift()!),
      refresh: () => {
        refreshes++;
        return pending.promise;
      },
    });

    source.event();
    clock.advance(200);
    await settle();
    source.event();
    source.event();
    source.event();
    pending.resolve();
    await settle();
    expect(checks).toBe(2);
    expect(refreshes).toBe(1);
  });

  test("retains the old baseline after refresh rejection and retries", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    const errors: unknown[] = [];
    let attempts = 0;
    const controller = createWatchController({
      initialSignature: "old",
      clock,
      createEventSource: source.create,
      getSignature: () => "new",
      refresh: () => {
        attempts++;
        if (attempts === 1) throw new Error("reload failed");
      },
      reportError: (error) => errors.push(error),
    });

    source.event();
    clock.advance(200);
    await settle();
    expect(controller.getState().appliedSignature).toBe("old");
    source.event();
    clock.advance(200);
    await settle();
    expect(attempts).toBe(2);
    expect(controller.getState().appliedSignature).toBe("new");
    expect(errors).toHaveLength(1);
  });

  test("keeps a signature exception retryable", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    let checks = 0;
    let refreshes = 0;
    createWatchController({
      initialSignature: "old",
      clock,
      createEventSource: source.create,
      getSignature: () => {
        checks++;
        if (checks === 1) throw new Error("stat failed");
        return "new";
      },
      refresh: () => {
        refreshes++;
      },
    });

    source.event();
    clock.advance(200);
    await settle();
    source.event();
    clock.advance(200);
    await settle();
    expect(checks).toBe(2);
    expect(refreshes).toBe(1);
  });

  test("checks the bootstrap signature immediately after source readiness", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    let checks = 0;
    createWatchController({
      initialSignature: "same",
      clock,
      createEventSource: source.create,
      getSignature: () => (++checks, "same"),
      refresh: () => {},
    });

    source.ready();
    await settle();
    expect(checks).toBe(1);
  });

  test("runs a healthy safety check without an event", async () => {
    const clock = new FakeWatchClock();
    let checks = 0;
    createWatchController({
      initialSignature: "same",
      clock,
      getSignature: () => (++checks, "same"),
      refresh: () => {},
    });

    clock.advance(9_999);
    expect(checks).toBe(0);
    clock.advance(1);
    await settle();
    expect(checks).toBe(1);
  });

  test("coalesces an event and safety deadline collision", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    let checks = 0;
    createWatchController({
      initialSignature: "same",
      clock,
      createEventSource: source.create,
      getSignature: () => (++checks, "same"),
      refresh: () => {},
    });

    clock.advance(9_800);
    source.event();
    clock.advance(200);
    await settle();
    expect(checks).toBe(1);
  });

  test("falls back to degraded polling when watcher startup fails", async () => {
    const clock = new FakeWatchClock();
    const failure = new Error("watcher unavailable");
    const errors: unknown[] = [];
    let checks = 0;
    const controller = createWatchController({
      initialSignature: "same",
      clock,
      createEventSource: () => {
        throw failure;
      },
      getSignature: () => (++checks, "same"),
      refresh: () => {},
      reportError: (error) => errors.push(error),
    });

    expect(controller.getState().degraded).toBe(true);
    clock.advance(2_000);
    await settle();
    expect(checks).toBe(1);
    expect(errors).toEqual([failure]);
  });

  test("classifies ENOSPC and EMFILE by code and rate-limits duplicate reports", () => {
    for (const code of ["ENOSPC", "EMFILE"]) {
      const clock = new FakeWatchClock();
      const source = fakeSource();
      const errors: unknown[] = [];
      const controller = createWatchController({
        initialSignature: "same",
        clock,
        createEventSource: source.create,
        getSignature: () => "same",
        refresh: () => {},
        reportError: (error) => errors.push(error),
      });
      source.error(Object.assign(new Error("resource limit"), { code }));
      source.error(Object.assign(new Error("resource limit again"), { code }));
      expect(controller.getState().degraded).toBe(true);
      expect(errors).toHaveLength(1);
    }
  });

  test("reports unknown source errors without degrading", () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    const errors: unknown[] = [];
    const failure = Object.assign(new Error("temporary"), { code: "EACCES" });
    const controller = createWatchController({
      initialSignature: "same",
      clock,
      createEventSource: source.create,
      getSignature: () => "same",
      refresh: () => {},
      reportError: (error) => errors.push(error),
    });

    source.error(failure);
    expect(controller.getState().degraded).toBe(false);
    expect(errors).toEqual([failure]);
  });

  test("supports poll-only plans on the degraded interval", async () => {
    const clock = new FakeWatchClock();
    let checks = 0;
    createWatchController({
      initialSignature: "same",
      clock,
      pollOnly: true,
      getSignature: () => (++checks, "same"),
      refresh: () => {},
    });
    clock.advance(2_000);
    await settle();
    expect(checks).toBe(1);
  });

  test("close is idempotent, cancels timers, and ignores late completion", async () => {
    const clock = new FakeWatchClock();
    const source = fakeSource();
    const signature = deferred<string>();
    let refreshes = 0;
    const controller = createWatchController({
      initialSignature: "old",
      clock,
      createEventSource: source.create,
      getSignature: () => signature.promise,
      refresh: () => {
        refreshes++;
      },
    });

    source.event();
    clock.advance(200);
    controller.close();
    controller.close();
    signature.resolve("new");
    await settle();
    clock.advance(20_000);
    expect(controller.getState().phase).toBe("closed");
    expect(refreshes).toBe(0);
    expect(source.closes).toBe(1);
    expect(clock.timers.size).toBe(0);
  });

  test("replacing a controller isolates the old input from the new one", async () => {
    const clock = new FakeWatchClock();
    const oldSource = fakeSource();
    const newSource = fakeSource();
    let oldChecks = 0;
    let newChecks = 0;
    const oldController = createWatchController({
      initialSignature: "old",
      clock,
      createEventSource: oldSource.create,
      getSignature: () => (++oldChecks, "old"),
      refresh: () => {},
    });
    oldController.close();
    createWatchController({
      initialSignature: "new",
      clock,
      createEventSource: newSource.create,
      getSignature: () => (++newChecks, "new"),
      refresh: () => {},
    });

    oldSource.event();
    newSource.event();
    clock.advance(200);
    await settle();
    expect(oldChecks).toBe(0);
    expect(newChecks).toBe(1);
  });
});
