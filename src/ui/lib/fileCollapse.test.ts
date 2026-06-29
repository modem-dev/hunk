import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { applyFileCollapse, collapsedFileVariant } from "./fileCollapse";

describe("collapsedFileVariant", () => {
  test("empties hunks, flags collapse, and preserves stats/identity", () => {
    const file = createTestDiffFile({ id: "a", path: "a.ts" });
    expect(file.metadata.hunks.length).toBeGreaterThan(0);

    const variant = collapsedFileVariant(file);

    expect(variant.metadata.hunks).toEqual([]);
    expect(variant.isCollapsed).toBe(true);
    expect(variant.id).toBe(file.id);
    expect(variant.stats).toEqual(file.stats);
    expect(variant.metadata.cacheKey).not.toBe(file.metadata.cacheKey);
  });

  test("returns a stable object so geometry caching can key on identity", () => {
    const file = createTestDiffFile({ id: "a", path: "a.ts" });
    expect(collapsedFileVariant(file)).toBe(collapsedFileVariant(file));
  });
});

describe("applyFileCollapse", () => {
  test("swaps only collapsed ids and leaves the array untouched when none collapse", () => {
    const a = createTestDiffFile({ id: "a", path: "a.ts" });
    const b = createTestDiffFile({ id: "b", path: "b.ts" });
    const files = [a, b];

    expect(applyFileCollapse(files, {})).toBe(files);

    const result = applyFileCollapse(files, { a: true });
    expect(result[0]!.isCollapsed).toBe(true);
    expect(result[1]).toBe(b);
  });
});
