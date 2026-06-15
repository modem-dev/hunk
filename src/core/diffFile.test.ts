import { describe, expect, test } from "bun:test";
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { buildDiffFile, countDiffStats, createSkippedLargeMetadata } from "./diffFile";

/** Parse real Pierre metadata for a small before/after pair. */
function metadataFor(before: string, after: string, name = "foo.ts"): FileDiffMetadata {
  return parseDiffFromFile(
    { name, contents: before, cacheKey: `${name}:before` },
    { name, contents: after, cacheKey: `${name}:after` },
    { context: 0 },
    true,
  );
}

describe("countDiffStats", () => {
  test("counts additions and deletions from change content", () => {
    const metadata = metadataFor("a\nb\nc\n", "a\nB\nc\nD\n");
    expect(countDiffStats(metadata)).toEqual({ additions: 2, deletions: 1 });
  });

  test("reports zero changes for identical content", () => {
    const metadata = metadataFor("same\n", "same\n");
    expect(countDiffStats(metadata)).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("buildDiffFile", () => {
  const metadata = metadataFor("a\nb\nc\n", "a\nB\nc\nD\n");

  test("derives id, path, language, and stats from the source metadata", () => {
    const file = buildDiffFile(metadata, "PATCH", 2, "src", null);
    expect(file.id).toBe("src:2:foo.ts");
    expect(file.path).toBe("foo.ts");
    expect(file.language).toBe("typescript");
    expect(file.patch).toBe("PATCH");
    expect(file.stats).toEqual({ additions: 2, deletions: 1 });
  });

  test("infers binary status from the patch when not given explicitly", () => {
    const binary = buildDiffFile(metadata, "Binary files a/x and b/x differ\n", 0, "src", null);
    expect(binary.isBinary).toBe(true);

    const text = buildDiffFile(metadata, "@@ -1 +1 @@\n-a\n+b\n", 0, "src", null);
    expect(text.isBinary).toBe(false);
  });

  test("prefers explicit binary and stats overrides over inferred values", () => {
    const file = buildDiffFile(metadata, "Binary files a/x and b/x differ\n", 0, "src", null, {
      isBinary: false,
      stats: { additions: 99, deletions: 1 },
      isUntracked: true,
    });
    expect(file.isBinary).toBe(false);
    expect(file.stats).toEqual({ additions: 99, deletions: 1 });
    expect(file.isUntracked).toBe(true);
  });

  test("passes a resolved source context to the fetcher builder", () => {
    let received: unknown;
    buildDiffFile(metadata, "patch", 0, "src", null, {
      isUntracked: true,
      sourceFetcherBuilder: (context) => {
        received = context;
        return undefined;
      },
    });
    expect(received).toMatchObject({
      path: "foo.ts",
      isUntracked: true,
      isBinary: false,
    });
  });
});

describe("createSkippedLargeMetadata", () => {
  test("produces partial, hunk-free placeholder metadata with a stable cache key", () => {
    const metadata = createSkippedLargeMetadata("big.ts", "change");
    expect(metadata).toMatchObject({
      name: "big.ts",
      type: "change",
      hunks: [],
      isPartial: true,
    });
    expect(metadata.cacheKey).toBe("big.ts:large-diff-skipped");
  });
});
