import { describe, expect, test } from "bun:test";
import { createNativeSessionBrokerLifecycleClock } from "./lifecycleClock";

/** Wait for one native-clock predicate while keeping failures bounded and actionable. */
async function waitForNativeClockTest(label: string, predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

describe("native session broker lifecycle clock", () => {
  test("runs a one-shot once and supports idempotent disposal before or after settlement", async () => {
    const clock = createNativeSessionBrokerLifecycleClock();
    let cancelledCalls = 0;
    const disposeCancelled = clock.schedule(() => {
      cancelledCalls += 1;
    }, 10);
    disposeCancelled();
    disposeCancelled();
    await Bun.sleep(25);
    expect(cancelledCalls).toBe(0);

    let settledCalls = 0;
    const disposeSettled = clock.schedule(() => {
      settledCalls += 1;
    }, 5);
    await waitForNativeClockTest("one-shot callback", () => settledCalls === 1);
    disposeSettled();
    disposeSettled();
    await Bun.sleep(20);
    expect(settledCalls).toBe(1);
  });

  test("uses delayed-first intervals, settles delays, and stops callbacks after disposal", async () => {
    const clock = createNativeSessionBrokerLifecycleClock();
    let intervalCalls = 0;
    const disposeInterval = clock.scheduleInterval(() => {
      intervalCalls += 1;
    }, 25);

    expect(intervalCalls).toBe(0);
    await Bun.sleep(5);
    expect(intervalCalls).toBe(0);
    await waitForNativeClockTest("two interval callbacks", () => intervalCalls >= 2);
    const callsAtDisposal = intervalCalls;
    disposeInterval();
    disposeInterval();
    await Bun.sleep(40);
    expect(intervalCalls).toBe(callsAtDisposal);

    let delaySettled = false;
    const delayed = clock.delay(5).then(() => {
      delaySettled = true;
    });
    expect(delaySettled).toBe(false);
    await waitForNativeClockTest("awaitable delay", () => delaySettled);
    await delayed;
    expect(delaySettled).toBe(true);
  });
});
