import { describe, expect, test } from "bun:test";
import { ReviewResourceBudgetError, ReviewResourceCache } from "./reviewResourceCache";

const KEY = {
  sessionId: "s-1",
  generation: "generation:p1:0",
  resourceId: "resource:patch:file:a",
};
const OTHER = { ...KEY, resourceId: "resource:patch:file:b" };

function bytes(length: number) {
  return new Uint8Array(length);
}

describe("ReviewResourceCache", () => {
  test("returns what it stored", () => {
    const cache = new ReviewResourceCache();
    cache.store(KEY, bytes(4));

    expect(cache.get(KEY)).toEqual(bytes(4));
    expect(cache.get(OTHER)).toBeUndefined();
    expect(cache.getCachedBytes()).toBe(4);
  });

  // Intent: the daemon holds many sessions, so retained bytes are capped across all of them.
  test("evicts the least recently used entry to stay inside the byte budget", () => {
    const cache = new ReviewResourceCache({ cacheBytes: 10 });
    cache.store(KEY, bytes(6));
    cache.store(OTHER, bytes(6));

    expect(cache.get(KEY)).toBeUndefined();
    expect(cache.get(OTHER)).toEqual(bytes(6));
    expect(cache.getCachedBytes()).toBe(6);
  });

  test("promotes a read entry so it is not the next evicted", () => {
    const cache = new ReviewResourceCache({ cacheBytes: 10 });
    cache.store(KEY, bytes(4));
    cache.store(OTHER, bytes(4));
    cache.get(KEY);
    cache.store({ ...KEY, resourceId: "resource:patch:file:c" }, bytes(4));

    expect(cache.get(KEY)).toBeDefined();
    expect(cache.get(OTHER)).toBeUndefined();
  });

  // Intent: C2 — assemblies in progress are bounded too, not just finished bytes.
  test("refuses a reservation that would exceed the in-flight budget", () => {
    const cache = new ReviewResourceCache({ inFlightBytes: 10 });
    cache.reserve(KEY, 8);

    expect(() => cache.reserve(OTHER, 8)).toThrow(ReviewResourceBudgetError);
    expect(cache.getReservedBytes()).toBe(8);
  });

  test("refuses more concurrent assemblies than the limit allows", () => {
    const cache = new ReviewResourceCache({ inFlightResources: 1 });
    cache.reserve(KEY, 1);

    expect(() => cache.reserve(OTHER, 1)).toThrow(ReviewResourceBudgetError);
  });

  test("refuses a second reservation for the same resource", () => {
    const cache = new ReviewResourceCache();
    cache.reserve(KEY, 1);

    expect(() => cache.reserve(KEY, 1)).toThrow(ReviewResourceBudgetError);
  });

  test("gives the budget back when a load settles", () => {
    const cache = new ReviewResourceCache({ inFlightBytes: 10 });
    const reservation = cache.reserve(KEY, 8);
    cache.release(reservation);

    expect(cache.getReservedBytes()).toBe(0);
    expect(() => cache.reserve(OTHER, 8)).not.toThrow();
  });

  // Intent: an unmeasured resource reserves one chunk and grows to what the writer says,
  // instead of reserving the whole kind ceiling and starving every other load.
  test("resizes a reservation to the size the writer declares", () => {
    const cache = new ReviewResourceCache({ inFlightBytes: 10 });
    const reservation = cache.reserve(KEY, 2);
    cache.resize(reservation, 9);

    expect(cache.getReservedBytes()).toBe(9);
    expect(() => cache.resize(reservation, 11)).toThrow(ReviewResourceBudgetError);
    cache.release(reservation);
    expect(cache.getReservedBytes()).toBe(0);
  });

  test("drops everything belonging to a retired generation", () => {
    const cache = new ReviewResourceCache();
    cache.store(KEY, bytes(4));
    const reservation = cache.reserve(OTHER, 4);
    cache.store({ ...KEY, generation: "generation:p1:1" }, bytes(4));

    cache.evictGeneration("s-1", "generation:p1:0");
    expect(cache.get(KEY)).toBeUndefined();
    expect(cache.getReservedBytes()).toBe(0);
    expect(cache.get({ ...KEY, generation: "generation:p1:1" })).toBeDefined();
    // The load that owned the dropped reservation still releases; that must be a no-op.
    cache.release(reservation);
    expect(cache.getReservedBytes()).toBe(0);
  });

  test("drops everything belonging to a departed session", () => {
    const cache = new ReviewResourceCache();
    cache.store(KEY, bytes(4));
    cache.store({ ...KEY, sessionId: "s-2" }, bytes(4));

    cache.evictSession("s-1");
    expect(cache.getEntryCount()).toBe(1);
    expect(cache.get({ ...KEY, sessionId: "s-2" })).toBeDefined();
  });

  test("clears completely on shutdown", () => {
    const cache = new ReviewResourceCache();
    cache.store(KEY, bytes(4));
    cache.reserve(OTHER, 4);

    cache.clear();
    expect(cache.getCachedBytes()).toBe(0);
    expect(cache.getReservedBytes()).toBe(0);
    expect(cache.getEntryCount()).toBe(0);
  });
});
