import { describe, expect, test } from "bun:test";
import type { HighlightedDiffCode } from "./diffRows";
import { createHighlightedDiffCache } from "./highlightedDiffCache";

/** Build a distinguishable cache value; identity is all these tests compare. */
function createTestHighlightedDiffCode(): HighlightedDiffCode {
  return { deletionLines: [], additionLines: [] };
}

describe("highlighted diff cache", () => {
  test("evicts the least recently used entry rather than the oldest highlight", () => {
    const cache = createHighlightedDiffCache(2);
    const onScreen = createTestHighlightedDiffCode();
    const scrolledPast = createTestHighlightedDiffCode();
    const prefetched = createTestHighlightedDiffCode();

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
    const cache = createHighlightedDiffCache(1);
    const first = createTestHighlightedDiffCode();
    const second = createTestHighlightedDiffCode();

    cache.set("first", first);
    expect(cache.peek("first")).toBe(first);

    cache.set("second", second);
    expect(cache.peek("first")).toBeUndefined();
    expect(cache.peek("second")).toBe(second);
  });

  test("re-storing a key refreshes recency without growing past the budget", () => {
    const cache = createHighlightedDiffCache(2);
    const replaced = createTestHighlightedDiffCode();
    const kept = createTestHighlightedDiffCode();
    const added = createTestHighlightedDiffCode();

    cache.set("reloaded", createTestHighlightedDiffCode());
    cache.set("kept", kept);
    cache.set("reloaded", replaced);
    cache.set("added", added);

    expect(cache.peek("reloaded")).toBe(replaced);
    expect(cache.peek("added")).toBe(added);
    expect(cache.peek("kept")).toBeUndefined();
  });

  test("keeps at least one entry when given a degenerate budget", () => {
    const cache = createHighlightedDiffCache(0);
    const only = createTestHighlightedDiffCode();

    cache.set("only", only);

    expect(cache.peek("only")).toBe(only);
  });
});
