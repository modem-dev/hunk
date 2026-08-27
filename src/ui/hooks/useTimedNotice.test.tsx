import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, Activity, StrictMode, useEffect, useMemo, useState } from "react";
import { useTimedNotice, type TimedNotice, type TimedNoticeScheduler } from "./useTimedNotice";

type ScheduledTask = {
  callback: () => void;
  canceled: boolean;
  delay: number;
  dueAt: number;
};

/** Provides deterministic timer control, including forced delivery of canceled callbacks. */
class TestScheduler implements TimedNoticeScheduler {
  readonly cleared: number[] = [];
  readonly tasks = new Map<number, ScheduledTask>();
  private nextId = 1;
  private now = 0;

  setTimeout(callback: () => void, durationMs: number) {
    const id = this.nextId++;
    this.tasks.set(id, {
      callback,
      canceled: false,
      delay: durationMs,
      dueAt: this.now + durationMs,
    });
    return id;
  }

  clearTimeout(timer: unknown) {
    const id = timer as number;
    this.cleared.push(id);
    const task = this.tasks.get(id);
    if (task) task.canceled = true;
  }

  /** Runs active callbacks due within the requested time window. */
  advance(durationMs: number) {
    this.now += durationMs;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.dueAt <= this.now)
      .sort(([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId);
    for (const [id, task] of due) {
      this.tasks.delete(id);
      if (!task.canceled) task.callback();
    }
  }

  /** Delivers a callback even when cancellation already marked it stale. */
  forceFire(id: number) {
    this.tasks.get(id)?.callback();
  }
}

/** Mounts one timed-notice channel and exposes its current hook result. */
async function renderNotice(durationMs = 100, scheduler = new TestScheduler()) {
  let notice!: TimedNotice;

  function Harness() {
    notice = useTimedNotice(durationMs, scheduler);
    return <text>{notice.text ?? ""}</text>;
  }

  const setup = await testRender(<Harness />, { width: 60, height: 2 });
  await act(async () => setup.renderOnce());
  return { current: () => notice, scheduler, setup };
}

/** Flushes a hook update through the terminal test renderer. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderOnce());
}

/** Destroys a mounted hook harness. */
async function destroy(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderer.destroy());
}

describe("useTimedNotice", () => {
  test("shows for the configured duration", async () => {
    const harness = await renderNotice(75);
    try {
      await act(async () => harness.current().show("Saved"));
      await flush(harness.setup);

      expect(harness.scheduler.tasks.get(1)?.delay).toBe(75);
      expect(harness.current().text).toBe("Saved");

      await act(async () => harness.scheduler.advance(74));
      await flush(harness.setup);
      expect(harness.current().text).toBe("Saved");

      await act(async () => harness.scheduler.advance(1));
      await flush(harness.setup);
      expect(harness.current().text).toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("restarts the full window for the same text and ignores the replaced timer", async () => {
    const harness = await renderNotice(100);
    try {
      await act(async () => harness.current().show("Copied"));
      await act(async () => harness.scheduler.advance(40));
      await act(async () => harness.current().show("Copied"));
      await flush(harness.setup);

      expect(harness.scheduler.cleared).toEqual([1]);
      await act(async () => harness.scheduler.forceFire(1));
      await flush(harness.setup);
      expect(harness.current().text).toBe("Copied");

      await act(async () => harness.scheduler.advance(99));
      await flush(harness.setup);
      expect(harness.current().text).toBe("Copied");

      await act(async () => harness.scheduler.advance(1));
      await flush(harness.setup);
      expect(harness.current().text).toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("replaces different text without letting the old timer clear it", async () => {
    const harness = await renderNotice();
    try {
      await act(async () => harness.current().show("First"));
      await act(async () => harness.current().show("Second"));
      await flush(harness.setup);

      await act(async () => harness.scheduler.forceFire(1));
      await flush(harness.setup);
      expect(harness.current().text).toBe("Second");
      expect(harness.scheduler.cleared).toEqual([1]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("explicit clear cancels the timer and protects against stale delivery", async () => {
    const harness = await renderNotice();
    try {
      await act(async () => harness.current().show("Working"));
      await act(async () => harness.current().clear());
      await flush(harness.setup);

      expect(harness.current().text).toBeNull();
      expect(harness.scheduler.cleared).toEqual([1]);
      await act(async () => harness.scheduler.forceFire(1));
      await flush(harness.setup);
      expect(harness.current().text).toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("a cleared callback cannot retire a newer notice", async () => {
    const harness = await renderNotice();
    try {
      await act(async () => harness.current().show("Old"));
      await act(async () => harness.current().clear());
      await act(async () => harness.current().show("New"));
      await flush(harness.setup);

      await act(async () => harness.scheduler.forceFire(1));
      await flush(harness.setup);
      expect(harness.current().text).toBe("New");
      expect(harness.scheduler.tasks.get(2)?.canceled).toBe(false);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("keeps independently configured channels isolated", async () => {
    const scheduler = new TestScheduler();
    let transient!: TimedNotice;
    let session!: TimedNotice;

    function Harness() {
      transient = useTimedNotice(3_000, scheduler);
      session = useTimedNotice(4_000, scheduler);
      return <text>{`${session.text ?? ""}|${transient.text ?? ""}`}</text>;
    }

    const setup = await testRender(<Harness />, { width: 60, height: 2 });
    try {
      await act(async () => {
        transient.show("Copied");
        session.show("Config failed");
      });
      await flush(setup);

      expect(scheduler.tasks.get(1)?.delay).toBe(3_000);
      expect(scheduler.tasks.get(2)?.delay).toBe(4_000);
      await act(async () => scheduler.advance(3_000));
      await flush(setup);
      expect(transient.text).toBeNull();
      expect(session.text).toBe("Config failed");

      await act(async () => scheduler.advance(1_000));
      await flush(setup);
      expect(session.text).toBeNull();
    } finally {
      await destroy(setup);
    }
  });

  test("cleans up the pending timer on unmount and invalidates its callback", async () => {
    const harness = await renderNotice();
    await act(async () => harness.current().show("Mounted"));
    await destroy(harness.setup);

    expect(harness.scheduler.cleared).toEqual([1]);
    expect(() => harness.scheduler.forceFire(1)).not.toThrow();
  });

  test("keeps timers valid through StrictMode effect replay and unmount", async () => {
    const scheduler = new TestScheduler();
    let notice!: TimedNotice;
    let setVisible!: (visible: boolean) => void;

    function Harness() {
      notice = useTimedNotice(100, scheduler);
      useEffect(() => {
        notice.show("Strict notice");
      }, [notice.show]);
      return <text>{notice.text ?? ""}</text>;
    }

    function ReplayHarness() {
      const [visible, updateVisible] = useState(true);
      setVisible = updateVisible;
      return (
        <StrictMode>
          <Activity mode={visible ? "visible" : "hidden"}>
            <Harness />
          </Activity>
        </StrictMode>
      );
    }

    const setup = await testRender(<ReplayHarness />, { width: 60, height: 2 });
    await flush(setup);
    expect(notice.text).toBe("Strict notice");
    expect(scheduler.tasks.get(1)?.canceled).toBe(false);

    await act(async () => setVisible(false));
    await flush(setup);
    expect(scheduler.cleared).toEqual([1]);
    expect(scheduler.tasks.get(1)?.canceled).toBe(true);

    await act(async () => setVisible(true));
    await flush(setup);
    expect(notice.text).toBe("Strict notice");
    expect(scheduler.cleared).toEqual([1, 2]);
    expect(scheduler.tasks.get(2)?.canceled).toBe(true);
    expect(scheduler.tasks.get(3)?.canceled).toBe(false);

    await destroy(setup);
    expect(scheduler.cleared).toEqual([1, 2, 3]);
    expect(() => scheduler.forceFire(3)).not.toThrow();
  });

  test("clears an old scheduler through its owner before scheduling through the new one", async () => {
    const schedulerA = new TestScheduler();
    const schedulerB = new TestScheduler();
    let notice!: TimedNotice;
    let useSchedulerB!: () => void;

    function Harness() {
      const [scheduler, setScheduler] = useState<TestScheduler>(schedulerA);
      useSchedulerB = () => setScheduler(schedulerB);
      notice = useTimedNotice(100, scheduler);
      return <text>{notice.text ?? ""}</text>;
    }

    const setup = await testRender(<Harness />, { width: 60, height: 2 });
    try {
      await flush(setup);
      await act(async () => notice.show("From A"));
      await act(async () => useSchedulerB());
      await flush(setup);
      await act(async () => notice.show("From B"));
      await flush(setup);

      expect(schedulerA.cleared).toEqual([1]);
      expect(schedulerA.tasks.get(1)?.canceled).toBe(true);
      expect(schedulerB.tasks.get(1)?.canceled).toBe(false);
      expect(notice.text).toBe("From B");
    } finally {
      await destroy(setup);
    }
  });

  test("keeps callbacks and dependent controllers stable across renders", async () => {
    const scheduler = new TestScheduler();
    let notice!: TimedNotice;
    let controller!: Pick<TimedNotice, "show" | "clear">;
    let setDuration!: (durationMs: number) => void;

    function Harness() {
      const [durationMs, updateDuration] = useState(10);
      setDuration = updateDuration;
      notice = useTimedNotice(durationMs, scheduler);
      controller = useMemo(
        () => ({ show: notice.show, clear: notice.clear }),
        [notice.show, notice.clear],
      );
      return <text>{notice.text ?? ""}</text>;
    }

    const setup = await testRender(<Harness />, { width: 60, height: 2 });
    try {
      await flush(setup);
      const initialShow = notice.show;
      const initialClear = notice.clear;
      const initialController = controller;

      await act(async () => notice.show("First"));
      await flush(setup);
      expect(notice.show).toBe(initialShow);
      expect(notice.clear).toBe(initialClear);
      expect(controller).toBe(initialController);

      await act(async () => setDuration(25));
      await flush(setup);
      await act(async () => notice.show("Second"));
      expect(scheduler.tasks.get(2)?.delay).toBe(25);
      expect(notice.show).toBe(initialShow);
      expect(controller).toBe(initialController);
    } finally {
      await destroy(setup);
    }
  });
});
