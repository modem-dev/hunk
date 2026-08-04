import { describe, expect, test } from "bun:test";

import { createDeadlineScheduler, type DeadlineClock } from "./watchDeadlines";

class FakeDeadlineClock implements DeadlineClock {
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
    for (;;) {
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

/** Build a scheduler plus a record of every time its timer fired. */
function createHarness() {
  const clock = new FakeDeadlineClock();
  const fires: number[] = [];
  const scheduler = createDeadlineScheduler({
    clock,
    onDue: () => fires.push(clock.nowMs),
  });
  return { clock, fires, scheduler };
}

describe("createDeadlineScheduler", () => {
  test("arms one timer for the earliest pending deadline", () => {
    const { clock, fires, scheduler } = createHarness();

    scheduler.set("safety", 10_000);
    scheduler.set("quiet", 200);
    scheduler.set("maximum", 1_000);
    scheduler.arm();

    // Three deadlines, one timer, aimed at the soonest.
    expect(clock.timers.size).toBe(1);
    expect(clock.scheduledDelays).toEqual([200]);

    clock.advance(200);
    expect(fires).toEqual([200]);
  });

  test("re-arming for an unchanged earliest deadline does not churn the timer", () => {
    const { clock, scheduler } = createHarness();

    scheduler.set("quiet", 200);
    scheduler.arm();
    scheduler.arm();
    scheduler.arm();

    expect(clock.scheduledDelays).toEqual([200]);
  });

  test("re-arming after a deadline moves earlier retargets the timer", () => {
    const { clock, fires, scheduler } = createHarness();

    scheduler.set("safety", 10_000);
    scheduler.arm();
    scheduler.set("quiet", 200);
    scheduler.arm();

    expect(clock.scheduledDelays).toEqual([10_000, 200]);
    clock.advance(200);
    expect(fires).toEqual([200]);
  });

  test("reports every deadline that has arrived, and no others", () => {
    const { scheduler } = createHarness();

    scheduler.set("quiet", 200);
    scheduler.set("maximum", 1_000);
    scheduler.set("safety", 10_000);

    expect(new Set(scheduler.due(1_000))).toEqual(new Set(["quiet", "maximum"]));
    expect(scheduler.due(199)).toEqual([]);
  });

  test("setIfUnset keeps the first value so a burst cannot extend its own cap", () => {
    const { scheduler } = createHarness();

    scheduler.setIfUnset("maximum", 1_000);
    scheduler.setIfUnset("maximum", 5_000);

    expect(scheduler.due(1_000)).toEqual(["maximum"]);
  });

  test("advance only ever moves a deadline earlier", () => {
    const { scheduler } = createHarness();

    scheduler.set("safety", 10_000);
    scheduler.advance("safety", 2_000);
    expect(scheduler.due(2_000)).toEqual(["safety"]);

    scheduler.advance("safety", 8_000);
    expect(scheduler.due(2_000)).toEqual(["safety"]);
  });

  test("advance sets the deadline when nothing is pending", () => {
    const { scheduler } = createHarness();

    scheduler.advance("safety", 2_000);
    expect(scheduler.has("safety")).toBe(true);
    expect(scheduler.due(2_000)).toEqual(["safety"]);
  });

  test("clear drops named deadlines, and clears everything when given no names", () => {
    const { scheduler } = createHarness();

    scheduler.set("quiet", 200);
    scheduler.set("maximum", 1_000);
    scheduler.set("safety", 10_000);

    scheduler.clear("quiet", "maximum");
    expect(scheduler.has("quiet")).toBe(false);
    expect(scheduler.has("safety")).toBe(true);

    scheduler.clear();
    expect(scheduler.has("safety")).toBe(false);
  });

  test("arming with nothing pending installs no timer", () => {
    const { clock, scheduler } = createHarness();

    scheduler.arm();
    expect(clock.timers.size).toBe(0);
  });

  test("disarm cancels the timer without discarding deadlines", () => {
    const { clock, fires, scheduler } = createHarness();

    scheduler.set("quiet", 200);
    scheduler.arm();
    scheduler.disarm();

    clock.advance(1_000);
    expect(fires).toEqual([]);
    // The deadline itself survived, so the owner can arm again later.
    expect(scheduler.due(1_000)).toEqual(["quiet"]);
  });

  test("stays disarmed after firing so the owner decides when to wake next", () => {
    const { clock, fires, scheduler } = createHarness();

    scheduler.set("quiet", 200);
    scheduler.arm();
    clock.advance(500);
    expect(fires).toEqual([200]);

    // A deadline still in the past does not re-fire on its own.
    clock.advance(5_000);
    expect(fires).toEqual([200]);
  });

  test("a deadline already in the past arms with a non-negative delay", () => {
    const { clock, fires, scheduler } = createHarness();

    clock.advance(1_000);
    scheduler.set("safety", 500);
    scheduler.arm();

    expect(clock.scheduledDelays).toEqual([0]);
    clock.advance(0);
    expect(fires).toEqual([1_000]);
  });
});
