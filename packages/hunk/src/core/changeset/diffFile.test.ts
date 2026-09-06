import { afterEach, describe, expect, test } from "bun:test";
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { buildDiffFile, countDiffStats, createSkippedLargeMetadata } from "./diffFile";
import { replaceExtensionFileLanguages } from "./fileLanguage";

afterEach(() => {
  replaceExtensionFileLanguages([]);
});

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

  test("derives TypeScript language for module and commonjs TypeScript files", () => {
    const mtsFile = buildDiffFile(metadataFor("a\n", "b\n", "foo.mts"), "PATCH", 0, "src", null);
    const ctsFile = buildDiffFile(metadataFor("a\n", "b\n", "foo.cts"), "PATCH", 1, "src", null);

    expect(mtsFile.language).toBe("typescript");
    expect(ctsFile.language).toBe("typescript");
  });

  test("pins extension-selected languages onto the metadata Pierre renders", () => {
    replaceExtensionFileLanguages([
      {
        matcher: { kind: "filename", value: "HunkSyntaxFile" },
        language: "python",
      },
    ]);
    const nested = buildDiffFile(
      metadataFor("a\n", "b\n", "pkg/HunkSyntaxFile"),
      "PATCH",
      0,
      "src",
      null,
    );

    expect(nested.language).toBe("python");
    expect(nested.metadata.lang).toBe("python");

    const plain = buildDiffFile(metadataFor("a\n", "b\n", "notes"), "PATCH", 1, "src", null);
    expect(plain.metadata.lang).toBe("text");
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

describe("change-block line pairing", () => {
  // Split view places paired lines side by side, and Pierre word-diffs a deletion against the
  // addition it is paired with. When a change block has unequal addition and deletion counts,
  // pairing by position would align unrelated lines and smear the inline highlight across the
  // whole row, so the engine has to re-split the block by content similarity instead.
  test("pairs a deletion with the similar addition, not the positionally first one", () => {
    const metadata = metadataFor(
      "start();\n  return computeTotal(items, taxRate);\nend();\n",
      "start();\n  const items = loadItems();\n  const taxRate = getTaxRate();\n  return computeTotal(items, taxRate, discount);\nend();\n",
    );

    const changes = metadata.hunks.flatMap((hunk) =>
      hunk.hunkContent.filter((content) => content.type === "change"),
    );
    expect(changes).toEqual([
      { additions: 2, deletions: 0, additionLineIndex: 1, deletionLineIndex: 1, type: "change" },
      { additions: 1, deletions: 1, additionLineIndex: 3, deletionLineIndex: 1, type: "change" },
    ]);

    const paired = changes[1]!;
    expect(metadata.deletionLines[paired.deletionLineIndex]).toContain(
      "return computeTotal(items, taxRate);",
    );
    expect(metadata.additionLines[paired.additionLineIndex]).toContain(
      "return computeTotal(items, taxRate, discount);",
    );
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
