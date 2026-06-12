import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../test/helpers/diff-helpers";
import {
  fileReviewedHunkHashes,
  hunkBodyLineCount,
  hunkBodyLines,
  resolveReviewedHunkIndices,
  reviewedHunkHash,
} from "./reviewedHunks";

/** Two-hunk fixture: edits at the top and bottom with stable middle lines. */
function createTwoHunkFile(overrides: { id?: string; path?: string } = {}) {
  return createTestDiffFile({
    before: lines("const a = 1;", "stable1", "stable2", "stable3", "const z = 1;"),
    after: lines("const a = 2;", "stable1", "stable2", "stable3", "const z = 2;"),
    context: 0,
    ...overrides,
  });
}

describe("hunkBodyLines", () => {
  test("reconstructs sign-prefixed body lines without the @@ header", () => {
    const file = createTestDiffFile({
      before: lines("keep", "old line", "tail"),
      after: lines("keep", "new line", "tail"),
      context: 1,
    });

    expect(file.metadata.hunks).toHaveLength(1);
    expect(hunkBodyLines(file.metadata, 0)).toEqual([
      " keep\n",
      "-old line\n",
      "+new line\n",
      " tail\n",
    ]);
  });

  test("returns empty for an out-of-range hunk index", () => {
    const file = createTwoHunkFile();
    expect(hunkBodyLines(file.metadata, 99)).toEqual([]);
  });
});

describe("hunkBodyLineCount", () => {
  test("counts context, deletion, and addition lines", () => {
    const file = createTestDiffFile({
      before: lines("keep", "old line", "tail"),
      after: lines("keep", "new line", "tail"),
      context: 1,
    });

    expect(hunkBodyLineCount(file.metadata, 0)).toBe(4);
    expect(hunkBodyLineCount(file.metadata, 99)).toBe(0);
  });
});

describe("reviewedHunkHash", () => {
  test("same body at shifted line numbers produces the same hash", () => {
    const original = createTestDiffFile({
      before: lines("padding", "old value", "tail"),
      after: lines("padding", "new value", "tail"),
      context: 0,
    });
    // Same edit, pushed further down the file by extra unchanged lines.
    const shifted = createTestDiffFile({
      before: lines("padding", "extra1", "extra2", "old value", "tail"),
      after: lines("padding", "extra1", "extra2", "new value", "tail"),
      context: 0,
    });

    expect(reviewedHunkHash(shifted, 0)).toBe(reviewedHunkHash(original, 0) as string);
  });

  test("changed body produces a different hash", () => {
    const file = createTwoHunkFile();
    const edited = createTestDiffFile({
      before: lines("const a = 1;", "stable1", "stable2", "stable3", "const z = 1;"),
      after: lines("const a = 3;", "stable1", "stable2", "stable3", "const z = 2;"),
      context: 0,
    });

    expect(reviewedHunkHash(edited, 0)).not.toBe(reviewedHunkHash(file, 0) as string);
    expect(reviewedHunkHash(edited, 1)).toBe(reviewedHunkHash(file, 1) as string);
  });

  test("different file path produces a different hash", () => {
    const fileA = createTwoHunkFile({ path: "a.ts" });
    const fileB = createTwoHunkFile({ id: "other", path: "b.ts" });

    expect(reviewedHunkHash(fileA, 0)).not.toBe(reviewedHunkHash(fileB, 0) as string);
  });

  test("context line and changed line with identical text do not collide", () => {
    // "shared" is context in one diff and an addition in the other.
    const asContext = createTestDiffFile({
      before: lines("shared", "old"),
      after: lines("shared", "new"),
      context: 1,
    });
    const asAddition = createTestDiffFile({
      before: lines("old"),
      after: lines("shared", "new"),
      context: 0,
    });

    expect(reviewedHunkHash(asContext, 0)).not.toBe(reviewedHunkHash(asAddition, 0) as string);
  });

  test("returns undefined for an out-of-range hunk index", () => {
    expect(reviewedHunkHash(createTwoHunkFile(), 99)).toBeUndefined();
  });
});

describe("fileReviewedHunkHashes", () => {
  test("identical-body hunks in one file get distinct hashes via occurrence index", () => {
    // Both hunks replace "old" with "new" with identical bodies.
    const file = createTestDiffFile({
      before: lines("old", "stable1", "stable2", "stable3", "old"),
      after: lines("new", "stable1", "stable2", "stable3", "new"),
      context: 0,
    });

    expect(file.metadata.hunks).toHaveLength(2);
    const [first, second] = fileReviewedHunkHashes(file);
    expect(first).not.toBe(second as string);
  });

  test("an unrelated extra hunk does not change other hunks' hashes", () => {
    const base = createTestDiffFile({
      before: lines("old top", "stable1", "stable2", "stable3", "tail"),
      after: lines("new top", "stable1", "stable2", "stable3", "tail"),
      context: 0,
    });
    const withExtraHunk = createTestDiffFile({
      before: lines("old top", "stable1", "stable2", "stable3", "tail"),
      after: lines("new top", "stable1", "stable2", "stable3", "changed tail"),
      context: 0,
    });

    expect(fileReviewedHunkHashes(withExtraHunk)[0]).toBe(
      fileReviewedHunkHashes(base)[0] as string,
    );
  });

  test("is cached per metadata identity", () => {
    const file = createTwoHunkFile();
    expect(fileReviewedHunkHashes(file)).toBe(fileReviewedHunkHashes({ ...file }));
  });
});

describe("resolveReviewedHunkIndices", () => {
  test("maps a reviewed-hash set back to hunk indices", () => {
    const file = createTwoHunkFile();
    const secondHash = reviewedHunkHash(file, 1) as string;

    const indices = resolveReviewedHunkIndices(file, new Set([secondHash, "not-a-real-hash"]));
    expect([...indices]).toEqual([1]);
  });

  test("returns an empty set when no hashes are reviewed", () => {
    expect(resolveReviewedHunkIndices(createTwoHunkFile(), new Set()).size).toBe(0);
  });
});
