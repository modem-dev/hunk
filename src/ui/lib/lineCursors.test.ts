import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import {
  buildLineCursors,
  findNextLineCursor,
  firstLineCursorInHunk,
  resolveLineCursor,
  type LineCursor,
} from "./lineCursors";

/** Build a file whose single hunk wraps one changed line in context. */
function createContextWrappedFile(id: string, path: string) {
  return createTestDiffFile({
    id,
    path,
    before: lines("one", "two", "three", "four"),
    after: lines("one", "TWO", "three", "four"),
    context: 1,
  });
}

/** Build a file with two separated single-line changes and no context. */
function createTwoHunkFile(id: string, path: string) {
  return createTestDiffFile({
    id,
    path,
    before: lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"),
    after: lines("A", "b", "c", "d", "e", "f", "g", "h", "i", "J"),
    context: 0,
  });
}

describe("buildLineCursors", () => {
  test("walks context and changed lines in rendered order", () => {
    const cursors = buildLineCursors([createContextWrappedFile("alpha", "alpha.ts")], "stack");

    expect(cursors).toEqual([
      { fileId: "alpha", hunkIndex: 0, target: { side: "new", line: 1 } },
      { fileId: "alpha", hunkIndex: 0, target: { side: "old", line: 2 } },
      { fileId: "alpha", hunkIndex: 0, target: { side: "new", line: 2 } },
      { fileId: "alpha", hunkIndex: 0, target: { side: "new", line: 3 } },
    ]);
  });

  test("keeps old and new line numbering independent across hunks", () => {
    const cursors = buildLineCursors([createTwoHunkFile("alpha", "alpha.ts")], "stack");

    expect(cursors).toEqual([
      { fileId: "alpha", hunkIndex: 0, target: { side: "old", line: 1 } },
      { fileId: "alpha", hunkIndex: 0, target: { side: "new", line: 1 } },
      { fileId: "alpha", hunkIndex: 1, target: { side: "old", line: 10 } },
      { fileId: "alpha", hunkIndex: 1, target: { side: "new", line: 10 } },
    ]);
  });

  test("pairs a change block's two sides per row in split layout", () => {
    const file = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("a", "b", "c"),
      after: lines("A", "B", "C"),
      context: 0,
    });

    expect(buildLineCursors([file], "split").map((cursor) => cursor.target)).toEqual([
      { side: "old", line: 1 },
      { side: "new", line: 1 },
      { side: "old", line: 2 },
      { side: "new", line: 2 },
      { side: "old", line: 3 },
      { side: "new", line: 3 },
    ]);
  });

  test("walks a change block one column at a time in stack layout", () => {
    const file = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("a", "b", "c"),
      after: lines("A", "B", "C"),
      context: 0,
    });

    expect(buildLineCursors([file], "stack").map((cursor) => cursor.target)).toEqual([
      { side: "old", line: 1 },
      { side: "old", line: 2 },
      { side: "old", line: 3 },
      { side: "new", line: 1 },
      { side: "new", line: 2 },
      { side: "new", line: 3 },
    ]);
  });

  test("flattens every visible file into one review stream", () => {
    const cursors = buildLineCursors(
      [createTwoHunkFile("alpha", "alpha.ts"), createTwoHunkFile("beta", "beta.ts")],
      "stack",
    );

    expect(cursors).toHaveLength(8);
    expect(cursors.slice(0, 4).every((cursor) => cursor.fileId === "alpha")).toBe(true);
    expect(cursors.slice(4).every((cursor) => cursor.fileId === "beta")).toBe(true);
  });

  test("returns nothing when no files are visible", () => {
    expect(buildLineCursors([], "stack")).toEqual([]);
  });
});

describe("findNextLineCursor", () => {
  const cursors = buildLineCursors(
    [createTwoHunkFile("alpha", "alpha.ts"), createTwoHunkFile("beta", "beta.ts")],
    "stack",
  );

  test("steps forward and backward one line at a time", () => {
    expect(findNextLineCursor(cursors, cursors[0]!, 1)).toEqual(cursors[1]!);
    expect(findNextLineCursor(cursors, cursors[1]!, -1)).toEqual(cursors[0]!);
  });

  test("rolls across hunk and file boundaries", () => {
    expect(findNextLineCursor(cursors, cursors[1]!, 1)).toEqual(cursors[2]!);
    expect(findNextLineCursor(cursors, cursors[3]!, 1)).toEqual(cursors[4]!);
    expect(findNextLineCursor(cursors, cursors[4]!, -1)).toEqual(cursors[3]!);
  });

  test("clamps at both ends instead of wrapping", () => {
    expect(findNextLineCursor(cursors, cursors[0]!, -1)).toEqual(cursors[0]!);
    expect(findNextLineCursor(cursors, cursors[cursors.length - 1]!, 1)).toEqual(
      cursors[cursors.length - 1]!,
    );
  });

  test("starts at the top of the stream when no cursor is set", () => {
    expect(findNextLineCursor(cursors, null, 1)).toEqual(cursors[0]!);
    expect(findNextLineCursor(cursors, null, -1)).toEqual(cursors[0]!);
  });

  test("recovers to the top when the current line left the stream", () => {
    const retired: LineCursor = {
      fileId: "gamma",
      hunkIndex: 4,
      target: { side: "new", line: 99 },
    };

    expect(findNextLineCursor(cursors, retired, 1)).toEqual(cursors[0]!);
  });

  test("returns nothing when the stream is empty", () => {
    expect(findNextLineCursor([], null, 1)).toBeNull();
  });
});

describe("firstLineCursorInHunk", () => {
  const cursors = buildLineCursors(
    [createTwoHunkFile("alpha", "alpha.ts"), createTwoHunkFile("beta", "beta.ts")],
    "stack",
  );

  test("seeds at the first line of the requested hunk", () => {
    expect(firstLineCursorInHunk(cursors, "beta", 1)).toEqual({
      fileId: "beta",
      hunkIndex: 1,
      target: { side: "old", line: 10 },
    });
  });

  test("falls back within the file when the hunk is gone", () => {
    expect(firstLineCursorInHunk(cursors, "beta", 7)?.fileId).toBe("beta");
  });

  test("falls back to the top of the stream without a selected file", () => {
    expect(firstLineCursorInHunk(cursors, undefined, 0)).toEqual(cursors[0]!);
  });

  test("returns nothing when the stream is empty", () => {
    expect(firstLineCursorInHunk([], "alpha", 0)).toBeNull();
  });
});

describe("resolveLineCursor", () => {
  const cursors = buildLineCursors([createTwoHunkFile("alpha", "alpha.ts")], "stack");

  test("keeps a cursor that still points at a real line", () => {
    expect(resolveLineCursor(cursors, cursors[2]!)).toEqual(cursors[2]!);
  });

  test("falls back to the same hunk when the line is gone", () => {
    const movedLine: LineCursor = {
      fileId: "alpha",
      hunkIndex: 1,
      target: { side: "new", line: 42 },
    };

    expect(resolveLineCursor(cursors, movedLine)).toEqual({
      fileId: "alpha",
      hunkIndex: 1,
      target: { side: "old", line: 10 },
    });
  });

  test("falls back to the same file when the hunk is gone", () => {
    const retiredHunk: LineCursor = {
      fileId: "alpha",
      hunkIndex: 9,
      target: { side: "new", line: 1 },
    };

    expect(resolveLineCursor(cursors, retiredHunk)?.fileId).toBe("alpha");
  });

  test("gives up when the file left the review stream", () => {
    const filteredOut: LineCursor = {
      fileId: "gamma",
      hunkIndex: 0,
      target: { side: "new", line: 1 },
    };

    expect(resolveLineCursor(cursors, filteredOut)).toBeNull();
  });

  test("gives up when there is no cursor to resolve", () => {
    expect(resolveLineCursor(cursors, null)).toBeNull();
  });
});
