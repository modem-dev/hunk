import { describe, expect, test } from "bun:test";
import type { HighlightedDiffCode } from "./diffRows";
import { createHighlightedDiffCache } from "./highlightedDiffCache";

/** Build a result retaining a known line count; identity is what these tests compare. */
function createTestHighlightedDiffCode(lines: number): HighlightedDiffCode {
  return {
    deletionLines: Array.from({ length: lines }, () => undefined),
    additionLines: [],
  };
}

describe("highlighted diff cache", () => {
  test("evicts the least recently used entry rather than the oldest highlight", () => {
    // Three 10-line results cost 18 each with per-entry overhead, so two fit and a third evicts.
    const cache = createHighlightedDiffCache(40);
    const onScreen = createTestHighlightedDiffCode(10);
    const scrolledPast = createTestHighlightedDiffCode(10);
    const prefetched = createTestHighlightedDiffCode(10);

    cache.set("on-screen", onScreen);
    cache.set("scrolled-past", scrolledPast);

    // The viewport prefetch re-reads the file the user is looking at before warming the next one.
    expect(cache.get("on-screen")).toBe(onScreen);
    cache.set("prefetched", prefetched);

    expect(cache.peek("on-screen")).toBe(onScreen);
    expect(cache.peek("prefetched")).toBe(prefetched);
    expect(cache.peek("scrolled-past")).toBeUndefined();
  });

  test("peeking does not protect an entry from eviction", () => {
    const cache = createHighlightedDiffCache(20);
    const first = createTestHighlightedDiffCode(10);
    const second = createTestHighlightedDiffCode(10);

    cache.set("first", first);
    expect(cache.peek("first")).toBe(first);

    cache.set("second", second);
    expect(cache.peek("first")).toBeUndefined();
    expect(cache.peek("second")).toBe(second);
  });

  test("holds far more small files than large ones under the same budget", () => {
    const cache = createHighlightedDiffCache(600);

    // A window of one-line fixes is what a lint or import sweep looks like.
    for (let index = 0; index < 50; index += 1) {
      cache.set(`small-${index}`, createTestHighlightedDiffCode(2));
    }
    expect(cache.peek("small-0")).toBeDefined();
    expect(cache.peek("small-49")).toBeDefined();

    // The same count of generated files cannot fit, and the recent ones win.
    for (let index = 0; index < 50; index += 1) {
      cache.set(`large-${index}`, createTestHighlightedDiffCode(60));
    }
    expect(cache.peek("large-49")).toBeDefined();
    expect(cache.peek("large-0")).toBeUndefined();
    expect(cache.peek("small-0")).toBeUndefined();
  });

  test("keeps a result larger than the whole budget rather than dropping it", () => {
    const cache = createHighlightedDiffCache(100);
    const neighbor = createTestHighlightedDiffCode(50);
    const generated = createTestHighlightedDiffCode(5000);

    cache.set("neighbor", neighbor);
    cache.set("generated", generated);

    expect(cache.peek("generated")).toBe(generated);
    expect(cache.peek("neighbor")).toBeUndefined();
  });

  test("releases the budget a replaced result was holding", () => {
    const cache = createHighlightedDiffCache(100);
    const reloaded = createTestHighlightedDiffCode(4);
    const kept = createTestHighlightedDiffCode(40);

    // A file whose diff shrinks between reloads must not keep charging its old size.
    cache.set("reloaded", createTestHighlightedDiffCode(90));
    cache.set("reloaded", reloaded);
    cache.set("kept", kept);

    expect(cache.peek("reloaded")).toBe(reloaded);
    expect(cache.peek("kept")).toBe(kept);
  });

  test("reclaims entries that retain no lines at all", () => {
    const cache = createHighlightedDiffCache(100);

    // Diffs past the highlight ceiling cache an empty result. A watch session reloading one
    // produces a fresh key per reload, so these have to age out like any other entry.
    for (let index = 0; index < 200; index += 1) {
      cache.set(`skipped-${index}`, createTestHighlightedDiffCode(0));
    }

    expect(cache.peek("skipped-199")).toBeDefined();
    expect(cache.peek("skipped-0")).toBeUndefined();
  });

  test("keeps one entry when given a degenerate budget", () => {
    const cache = createHighlightedDiffCache(0);
    const only = createTestHighlightedDiffCode(5);

    cache.set("only", only);

    expect(cache.peek("only")).toBe(only);
  });
});
