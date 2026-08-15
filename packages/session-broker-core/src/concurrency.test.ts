import { describe, expect, test } from "bun:test";
import { ConcurrencyGate, inBoundedParallel } from "./concurrency";

/** A promise a test resolves by hand, so concurrency can be observed rather than timed. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("inBoundedParallel", () => {
  test("returns results in input order however they finish", async () => {
    const results = await inBoundedParallel([5, 1, 4, 2, 3], 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 10;
    });

    expect(results).toEqual([50, 10, 40, 20, 30]);
  });

  test("passes each item's own index to the work", async () => {
    const results = await inBoundedParallel(["a", "b", "c"], 2, async (item, index) =>
      Promise.resolve(`${index}:${item}`),
    );

    expect(results).toEqual(["0:a", "1:b", "2:c"]);
  });

  test("never has more than the limit in flight", async () => {
    const gates = Array.from({ length: 6 }, deferred);
    let inFlight = 0;
    let peak = 0;

    const run = inBoundedParallel(gates, 2, async (gate) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate.promise;
      inFlight -= 1;
      return true;
    });
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    await run;

    expect(peak).toBe(2);
  });

  test("starts no more workers than there is work", async () => {
    let started = 0;

    await inBoundedParallel([1, 2], 10, async (item) => {
      started += 1;
      return item;
    });

    expect(started).toBe(2);
  });

  // The clamp that had already drifted: an unclamped `Math.min(limit, n)` starts zero
  // workers for a limit of zero and never settles. One is the floor.
  test("runs serially rather than never when the limit is below one", async () => {
    for (const limit of [0, -3, Number.NaN]) {
      let inFlight = 0;
      let peak = 0;

      const results = await inBoundedParallel([1, 2, 3], limit, async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return item;
      });

      expect(results).toEqual([1, 2, 3]);
      expect(peak).toBe(1);
    }
  });

  test("answers an empty list without running anything", async () => {
    let started = 0;

    expect(await inBoundedParallel([], 4, async () => (started += 1))).toEqual([]);
    expect(started).toBe(0);
  });
});

describe("ConcurrencyGate", () => {
  test("hands out its slots at once and holds the rest", async () => {
    const gate = new ConcurrencyGate(2);
    let third = false;

    await gate.acquire();
    await gate.acquire();
    void gate.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();

    expect(gate.inFlight).toBe(2);
    expect(third).toBe(false);

    gate.release();
    await Promise.resolve();
    expect(third).toBe(true);
    expect(gate.inFlight).toBe(2);
  });

  test("releases waiters in the order they queued", async () => {
    const gate = new ConcurrencyGate(1);
    const order: number[] = [];

    await gate.acquire();
    const waiters = [1, 2, 3].map((id) => gate.acquire().then(() => order.push(id)));
    for (const _ of waiters) {
      gate.release();
      await Promise.resolve();
    }
    await Promise.all(waiters);

    expect(order).toEqual([1, 2, 3]);
  });

  test("keeps a single slot when the limit is below one", async () => {
    const gate = new ConcurrencyGate(0);
    let second = false;

    await gate.acquire();
    void gate.acquire().then(() => {
      second = true;
    });
    await Promise.resolve();

    expect(second).toBe(false);
    gate.release();
    await Promise.resolve();
    expect(second).toBe(true);
  });
});
