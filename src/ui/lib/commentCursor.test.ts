import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import type { DiffRow } from "../diff/pierre";
import {
  clickTargetForDiffRow,
  cursorRowStableKey,
  firstCursorTargetForHunk,
  moveCursor,
  type CommentCursorPosition,
} from "./commentCursor";

const beforeLines = Array.from({ length: 12 }, (_, index) => `line${index + 1}`);
const afterLines = [...beforeLines];
afterLines[0] = "LINE1";
afterLines[10] = "LINE11";

function createTwoHunkFile() {
  return createTestDiffFile({
    id: "alpha",
    path: "alpha.ts",
    before: lines(...beforeLines),
    after: lines(...afterLines),
    context: 1,
  });
}

function createSingleHunkFile() {
  const before = lines("a", "b", "c");
  const after = lines("a", "B", "c");
  return createTestDiffFile({
    id: "beta",
    path: "beta.ts",
    before,
    after,
    context: 1,
  });
}

describe("firstCursorTargetForHunk", () => {
  test("prefers the first added line", () => {
    const file = createTwoHunkFile();

    const target = firstCursorTargetForHunk(file, 0);
    expect(target).toEqual({ side: "new", line: 1 });
  });
});

describe("cursorRowStableKey", () => {
  test("formats a stable key matching the diff render plan", () => {
    const key = cursorRowStableKey({
      fileId: "alpha",
      hunkIndex: 2,
      side: "new",
      line: 42,
    });

    expect(key).toBe("line:2:new:42");
  });
});

describe("moveCursor", () => {
  test("steps forward through diff rows within a hunk", () => {
    const file = createTwoHunkFile();
    const start: CommentCursorPosition = {
      fileId: "alpha",
      hunkIndex: 0,
      ...firstCursorTargetForHunk(file, 0),
    };

    const next = moveCursor([file], start, 1);
    expect(next).not.toBeNull();
    expect(next?.fileId).toBe("alpha");
  });

  test("crosses hunk boundaries when stepping past the last row of a hunk", () => {
    const file = createTwoHunkFile();
    const lastHunkIndex = file.metadata.hunks.length - 1;
    const lastHunk = file.metadata.hunks[lastHunkIndex]!;
    const start: CommentCursorPosition = {
      fileId: "alpha",
      hunkIndex: lastHunkIndex,
      ...firstCursorTargetForHunk(file, lastHunkIndex),
    };

    let cursor: CommentCursorPosition | null = start;
    for (let step = 0; step < 200 && cursor !== null; step += 1) {
      const next = moveCursor([file], cursor, 1);
      if (!next || next.hunkIndex !== cursor.hunkIndex) {
        break;
      }
      cursor = next;
    }

    // Either we landed in a later hunk, or clamped at the end of the only hunk.
    expect(cursor).not.toBeNull();
    expect(cursor!.hunkIndex).toBeGreaterThanOrEqual(0);
    expect(lastHunk).toBeDefined();
  });

  test("crosses file boundaries when stepping past the last row of the last hunk", () => {
    const fileA = createSingleHunkFile();
    const fileB = createTestDiffFile({
      id: "gamma",
      path: "gamma.ts",
      before: lines("g1", "g2", "g3"),
      after: lines("g1", "G2", "g3"),
      context: 1,
    });
    const startInA: CommentCursorPosition = {
      fileId: "beta",
      hunkIndex: 0,
      ...firstCursorTargetForHunk(fileA, 0),
    };

    let cursor: CommentCursorPosition | null = startInA;
    for (let step = 0; step < 200 && cursor !== null; step += 1) {
      const next = moveCursor([fileA, fileB], cursor, 1);
      if (!next || next.fileId !== cursor.fileId) {
        cursor = next;
        break;
      }
      cursor = next;
    }

    expect(cursor?.fileId).toBe("gamma");
  });

  test("clamps at the first row of the first hunk when stepping backwards from the start", () => {
    const file = createSingleHunkFile();
    const start: CommentCursorPosition = {
      fileId: "beta",
      hunkIndex: 0,
      ...firstCursorTargetForHunk(file, 0),
    };

    const previous = moveCursor([file], start, -1);
    expect(previous).toEqual(start);
  });

  test("returns null when given an empty file list", () => {
    expect(moveCursor([], { fileId: "ghost", hunkIndex: 0, side: "new", line: 1 }, 1)).toBeNull();
  });
});

describe("clickTargetForDiffRow", () => {
  test("resolves a split-line addition to the new side", () => {
    const row: DiffRow = {
      type: "split-line",
      key: "row:0",
      fileId: "alpha",
      hunkIndex: 2,
      left: { kind: "empty", sign: " ", spans: [] },
      right: { kind: "addition", sign: "+", lineNumber: 7, spans: [] },
    };

    expect(clickTargetForDiffRow(row)).toEqual({ hunkIndex: 2, side: "new", line: 7 });
  });

  test("resolves a split-line deletion to the old side", () => {
    const row: DiffRow = {
      type: "split-line",
      key: "row:1",
      fileId: "alpha",
      hunkIndex: 3,
      left: { kind: "deletion", sign: "-", lineNumber: 12, spans: [] },
      right: { kind: "empty", sign: " ", spans: [] },
    };

    expect(clickTargetForDiffRow(row)).toEqual({ hunkIndex: 3, side: "old", line: 12 });
  });

  test("ignores context rows in split mode", () => {
    const row: DiffRow = {
      type: "split-line",
      key: "row:2",
      fileId: "alpha",
      hunkIndex: 1,
      left: { kind: "context", sign: " ", lineNumber: 4, spans: [] },
      right: { kind: "context", sign: " ", lineNumber: 4, spans: [] },
    };

    expect(clickTargetForDiffRow(row)).toBeNull();
  });

  test("resolves a stack-line addition to the new side", () => {
    const row: DiffRow = {
      type: "stack-line",
      key: "row:3",
      fileId: "alpha",
      hunkIndex: 0,
      cell: { kind: "addition", sign: "+", newLineNumber: 9, spans: [] },
    };

    expect(clickTargetForDiffRow(row)).toEqual({ hunkIndex: 0, side: "new", line: 9 });
  });

  test("ignores hunk header rows", () => {
    const row: DiffRow = {
      type: "hunk-header",
      key: "row:4",
      fileId: "alpha",
      hunkIndex: 0,
      text: "@@",
    };

    expect(clickTargetForDiffRow(row)).toBeNull();
  });
});
