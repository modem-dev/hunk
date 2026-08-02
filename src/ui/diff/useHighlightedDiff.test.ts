import { describe, expect, test } from "bun:test";
import { createTestDiffFile, createTestSourceFetcher } from "../../../test/helpers/diff-helpers";
import { resolveTheme } from "../themes";
import { highlightedDiffCacheKey } from "./useHighlightedDiff";

describe("highlighted diff cache keys", () => {
  test("invalidates source-backed partial highlights when the source provider changes", () => {
    const base = createTestDiffFile({ id: "cache", path: "cache.ts" });
    const firstFetcher = createTestSourceFetcher(() => "first source\n");
    const secondFetcher = createTestSourceFetcher(() => "second source\n");
    const first = {
      ...base,
      metadata: { ...base.metadata, isPartial: true },
      sourceFetcher: firstFetcher,
    };
    const second = { ...first, sourceFetcher: secondFetcher };
    const theme = resolveTheme("github-dark-default", null);

    expect(highlightedDiffCacheKey(theme, first)).toBe(highlightedDiffCacheKey(theme, first));
    expect(highlightedDiffCacheKey(theme, first)).not.toBe(highlightedDiffCacheKey(theme, second));
    expect(
      highlightedDiffCacheKey(theme, {
        ...first,
        metadata: { ...first.metadata, isPartial: false },
      }),
    ).toBe(
      highlightedDiffCacheKey(theme, {
        ...second,
        metadata: { ...second.metadata, isPartial: false },
      }),
    );
  });
});
