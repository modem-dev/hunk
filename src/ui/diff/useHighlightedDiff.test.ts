import { describe, expect, test } from "bun:test";
import { createTestDiffFile, createTestSourceFetcher } from "../../../test/helpers/diff-helpers";
import { resolveTheme } from "../themes";
import { buildStackRows } from "./pierre";
import { highlightedDiffCacheKey, prefetchHighlightedDiff } from "./useHighlightedDiff";

describe("highlighted diff cache keys", () => {
  test("loads a new cached result when extension reload changes the detected language", async () => {
    const baseFile = createTestDiffFile({ id: "cache-language", path: "example.custom" });
    const plainFile = {
      ...baseFile,
      language: undefined,
      metadata: { ...baseFile.metadata, lang: "text" as const },
    };
    const typedFile = {
      ...baseFile,
      language: "typescript",
      metadata: { ...baseFile.metadata, lang: "typescript" as const },
    };
    const theme = resolveTheme("github-dark-default", null);

    const plain = await prefetchHighlightedDiff({ file: plainFile, theme });
    const typed = await prefetchHighlightedDiff({ file: typedFile, theme });
    const typedAgain = await prefetchHighlightedDiff({ file: typedFile, theme });
    const plainSpans = buildStackRows(plainFile, plain, theme)
      .filter((row) => row.type === "stack-line" && row.cell.kind === "addition")
      .flatMap((row) => (row.type === "stack-line" ? row.cell.spans : []));
    const typedSpans = buildStackRows(typedFile, typed, theme)
      .filter((row) => row.type === "stack-line" && row.cell.kind === "addition")
      .flatMap((row) => (row.type === "stack-line" ? row.cell.spans : []));

    expect(highlightedDiffCacheKey(theme, plainFile)).not.toBe(
      highlightedDiffCacheKey(theme, typedFile),
    );
    expect(typed).not.toBe(plain);
    expect(typedAgain).toBe(typed);
    expect(plainSpans.some((span) => span.fg !== undefined)).toBe(false);
    expect(typedSpans.some((span) => span.fg !== undefined)).toBe(true);
  });

  test("invalidates source-backed partial highlights when an unversioned provider changes", () => {
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

  test("reuses source-backed highlights for equivalent versioned providers", () => {
    const base = createTestDiffFile({ id: "cache", path: "cache.ts" });
    const firstFetcher = Object.assign(
      createTestSourceFetcher(() => "same source\n"),
      {
        cacheKey: "snapshot-1",
      },
    );
    const secondFetcher = Object.assign(
      createTestSourceFetcher(() => "same source\n"),
      {
        cacheKey: "snapshot-1",
      },
    );
    const changedFetcher = Object.assign(
      createTestSourceFetcher(() => "changed source\n"),
      {
        cacheKey: "snapshot-2",
      },
    );
    const file = {
      ...base,
      metadata: { ...base.metadata, isPartial: true },
      sourceFetcher: firstFetcher,
    };
    const theme = resolveTheme("github-dark-default", null);

    expect(highlightedDiffCacheKey(theme, file)).toBe(
      highlightedDiffCacheKey(theme, { ...file, sourceFetcher: secondFetcher }),
    );
    expect(highlightedDiffCacheKey(theme, file)).not.toBe(
      highlightedDiffCacheKey(theme, { ...file, sourceFetcher: changedFetcher }),
    );
  });
});
