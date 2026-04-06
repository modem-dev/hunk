import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../../core/types";
import { buildAnnotatedHunkCursors, findNextHunkCursor, type HunkCursor } from "./hunks";

/** Build a minimal DiffFile with real Pierre-parsed hunks and optional annotations. */
function createTestFile(
  id: string,
  path: string,
  before: string,
  after: string,
  annotations: DiffFile["agent"],
): DiffFile {
  const metadata = parseDiffFromFile(
    { name: path, contents: before, cacheKey: `${id}:before` },
    { name: path, contents: after, cacheKey: `${id}:after` },
    { context: 3 },
    true,
  );

  return {
    id,
    path,
    patch: "",
    language: "typescript",
    stats: { additions: 0, deletions: 0 },
    metadata,
    agent: annotations,
  };
}

describe("hunk navigation", () => {
  const cursors: HunkCursor[] = [
    { fileId: "alpha", hunkIndex: 0 },
    { fileId: "alpha", hunkIndex: 1 },
    { fileId: "beta", hunkIndex: 0 },
  ];

  test("moves forward across hunk and file boundaries", () => {
    expect(findNextHunkCursor(cursors, "alpha", 0, 1)).toEqual({ fileId: "alpha", hunkIndex: 1 });
    expect(findNextHunkCursor(cursors, "alpha", 1, 1)).toEqual({ fileId: "beta", hunkIndex: 0 });
  });

  test("moves backward across file boundaries", () => {
    expect(findNextHunkCursor(cursors, "beta", 0, -1)).toEqual({ fileId: "alpha", hunkIndex: 1 });
    expect(findNextHunkCursor(cursors, "alpha", 1, -1)).toEqual({ fileId: "alpha", hunkIndex: 0 });
  });

  test("clamps at the ends of the review stream", () => {
    expect(findNextHunkCursor(cursors, "alpha", 0, -1)).toEqual({ fileId: "alpha", hunkIndex: 0 });
    expect(findNextHunkCursor(cursors, "beta", 0, 1)).toEqual({ fileId: "beta", hunkIndex: 0 });
  });

  test("starts at the nearest stream edge when no current hunk is selected", () => {
    expect(findNextHunkCursor(cursors, undefined, 0, 1)).toEqual({ fileId: "alpha", hunkIndex: 0 });
    expect(findNextHunkCursor(cursors, undefined, 0, -1)).toEqual({ fileId: "beta", hunkIndex: 0 });
  });
});

describe("annotated hunk navigation", () => {
  // Two-hunk file: lines 1-10 change in hunk 0, lines 20-30 change in hunk 1.
  const beforeA =
    "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n" +
    "gap11\ngap12\ngap13\ngap14\ngap15\ngap16\ngap17\ngap18\ngap19\n" +
    "line20\nline21\nline22\nline23\nline24\nline25\nline26\nline27\nline28\nline29\nline30\n";
  const afterA =
    "CHANGED1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n" +
    "gap11\ngap12\ngap13\ngap14\ngap15\ngap16\ngap17\ngap18\ngap19\n" +
    "CHANGED20\nline21\nline22\nline23\nline24\nline25\nline26\nline27\nline28\nline29\nline30\n";

  // Single-hunk file: one change at line 1.
  const beforeB = "old\n";
  const afterB = "new\n";

  test("only includes hunks that have overlapping annotations", () => {
    // Hunk 0 new range is [1,1], hunk 1 new range is [17,17].
    // Annotate only hunk 1 in file alpha, and hunk 0 in file beta.
    const fileA = createTestFile("alpha", "alpha.ts", beforeA, afterA, {
      path: "alpha.ts",
      annotations: [{ newRange: [17, 17], summary: "Note on hunk 1" }],
    });
    const fileB = createTestFile("beta", "beta.ts", beforeB, afterB, {
      path: "beta.ts",
      annotations: [{ newRange: [1, 1], summary: "Note on beta" }],
    });

    expect(fileA.metadata.hunks.length).toBe(2);
    const annotatedCursors = buildAnnotatedHunkCursors([fileA, fileB]);

    // Alpha hunk 0 (line 1) has no annotation, so it should be skipped.
    expect(annotatedCursors).toEqual([
      { fileId: "alpha", hunkIndex: 1 },
      { fileId: "beta", hunkIndex: 0 },
    ]);
  });

  test("returns an empty list when no files have annotations", () => {
    const fileA = createTestFile("alpha", "alpha.ts", beforeA, afterA, null);
    const fileB = createTestFile("beta", "beta.ts", beforeB, afterB, null);

    expect(buildAnnotatedHunkCursors([fileA, fileB])).toEqual([]);
  });

  test("skips files with agent context but no matching annotations", () => {
    // Annotation range doesn't overlap any hunk (line 10 is in the gap between hunks).
    const fileA = createTestFile("alpha", "alpha.ts", beforeA, afterA, {
      path: "alpha.ts",
      annotations: [{ newRange: [10, 10], summary: "Note in gap, no hunk overlap" }],
    });

    expect(buildAnnotatedHunkCursors([fileA])).toEqual([]);
  });

  test("navigates forward and backward through annotated cursors only", () => {
    // Annotate only hunk 1 (new range [17,17]) in alpha, and hunk 0 in beta.
    const fileA = createTestFile("alpha", "alpha.ts", beforeA, afterA, {
      path: "alpha.ts",
      annotations: [{ newRange: [17, 17], summary: "Note on hunk 1 only" }],
    });
    const fileB = createTestFile("beta", "beta.ts", beforeB, afterB, {
      path: "beta.ts",
      annotations: [{ newRange: [1, 1], summary: "Note on beta" }],
    });

    const annotatedCursors = buildAnnotatedHunkCursors([fileA, fileB]);

    // Forward from alpha hunk 1 → beta hunk 0
    expect(findNextHunkCursor(annotatedCursors, "alpha", 1, 1)).toEqual({
      fileId: "beta",
      hunkIndex: 0,
    });

    // Backward from beta hunk 0 → alpha hunk 1
    expect(findNextHunkCursor(annotatedCursors, "beta", 0, -1)).toEqual({
      fileId: "alpha",
      hunkIndex: 1,
    });

    // Clamps at ends
    expect(findNextHunkCursor(annotatedCursors, "alpha", 1, -1)).toEqual({
      fileId: "alpha",
      hunkIndex: 1,
    });
    expect(findNextHunkCursor(annotatedCursors, "beta", 0, 1)).toEqual({
      fileId: "beta",
      hunkIndex: 0,
    });
  });

  test("jumps from an unannotated hunk to the nearest annotated one", () => {
    // Only hunk 1 (new range [17,17]) is annotated; hunk 0 is not.
    const fileA = createTestFile("alpha", "alpha.ts", beforeA, afterA, {
      path: "alpha.ts",
      annotations: [{ newRange: [17, 17], summary: "Note on hunk 1 only" }],
    });

    const annotatedCursors = buildAnnotatedHunkCursors([fileA]);

    // Current position is alpha hunk 0, which is not in the annotated list.
    // Forward should land on the first annotated cursor.
    expect(findNextHunkCursor(annotatedCursors, "alpha", 0, 1)).toEqual({
      fileId: "alpha",
      hunkIndex: 1,
    });

    // Backward from an unknown position should land on the last annotated cursor.
    expect(findNextHunkCursor(annotatedCursors, "alpha", 0, -1)).toEqual({
      fileId: "alpha",
      hunkIndex: 1,
    });
  });
});
