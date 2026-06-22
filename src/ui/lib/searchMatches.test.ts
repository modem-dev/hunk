import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/types";
import type { DiffRow, SplitLineCell, StackLineCell } from "../diff/pierre";
import { findMatchesInFiles, findSearchMatches, moveSearchCursor } from "./searchMatches";

function fileWithPatch(id: string, path: string, patch: string): DiffFile {
  return {
    id,
    path,
    patch,
    language: "ts",
    stats: { additions: 0, deletions: 0 },
    metadata: {
      name: path,
      type: "change",
      hunks: [],
      splitLineCount: 0,
      unifiedLineCount: 0,
      isPartial: false,
      additionLines: [],
      deletionLines: [],
      cacheKey: `${id}:cache`,
    },
    agent: null,
  };
}

function stack(text: string, fileId = "f", hunkIndex = 0): DiffRow {
  const cell: StackLineCell = {
    kind: "context",
    sign: " ",
    spans: [{ text }],
  };
  return { type: "stack-line", key: `${fileId}:${text}`, fileId, hunkIndex, cell };
}

function split(left: string, right: string, fileId = "f", hunkIndex = 0): DiffRow {
  const leftCell: SplitLineCell = { kind: "context", sign: " ", spans: [{ text: left }] };
  const rightCell: SplitLineCell = { kind: "context", sign: " ", spans: [{ text: right }] };
  return {
    type: "split-line",
    key: `${fileId}:${left}:${right}`,
    fileId,
    hunkIndex,
    left: leftCell,
    right: rightCell,
  };
}

function header(fileId = "f", hunkIndex = 0): DiffRow {
  return {
    type: "hunk-header",
    key: `${fileId}:h${hunkIndex}`,
    fileId,
    hunkIndex,
    text: "@@ header @@",
  };
}

describe("findSearchMatches", () => {
  test("empty query returns no matches", () => {
    const rows: DiffRow[] = [stack("hello world")];
    expect(findSearchMatches(rows, "")).toEqual([]);
  });

  test("finds substring in stack-line row", () => {
    const rows: DiffRow[] = [stack("the quick brown fox")];
    const matches = findSearchMatches(rows, "quick");
    expect(matches).toEqual([
      { rowIndex: 0, fileId: "f", hunkIndex: 0, side: "single", columnStart: 4, columnEnd: 9 },
    ]);
  });

  test("case-insensitive by default", () => {
    const rows: DiffRow[] = [stack("Hello World")];
    const matches = findSearchMatches(rows, "hello");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.columnStart).toBe(0);
  });

  test("case-sensitive when opted in", () => {
    const rows: DiffRow[] = [stack("Hello World")];
    expect(findSearchMatches(rows, "hello", { caseSensitive: true })).toEqual([]);
    expect(findSearchMatches(rows, "Hello", { caseSensitive: true })).toHaveLength(1);
  });

  test("multiple non-overlapping matches in one row", () => {
    const rows: DiffRow[] = [stack("abab abab")];
    const matches = findSearchMatches(rows, "ab");
    expect(matches.map((m) => m.columnStart)).toEqual([0, 2, 5, 7]);
  });

  test("emits one match per side on a split row", () => {
    const rows: DiffRow[] = [split("foo bar", "bar foo")];
    const matches = findSearchMatches(rows, "foo");
    expect(matches).toEqual([
      { rowIndex: 0, fileId: "f", hunkIndex: 0, side: "left", columnStart: 0, columnEnd: 3 },
      { rowIndex: 0, fileId: "f", hunkIndex: 0, side: "right", columnStart: 4, columnEnd: 7 },
    ]);
  });

  test("skips non-line rows like hunk headers and collapsed gaps", () => {
    const rows: DiffRow[] = [
      header(),
      stack("match here"),
      {
        type: "collapsed",
        key: "gap",
        fileId: "f",
        hunkIndex: 0,
        text: "expand 3 lines",
        position: "before",
        oldRange: [1, 3],
        newRange: [1, 3],
      },
    ];
    const matches = findSearchMatches(rows, "match");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.rowIndex).toBe(1);
  });

  test("concatenates spans within a single line before searching", () => {
    const cell: StackLineCell = {
      kind: "addition",
      sign: "+",
      spans: [{ text: "foo" }, { text: "bar" }, { text: "baz" }],
    };
    const row: DiffRow = {
      type: "stack-line",
      key: "k",
      fileId: "f",
      hunkIndex: 0,
      cell,
    };
    const matches = findSearchMatches([row], "obar");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.columnStart).toBe(2);
    expect(matches[0]!.columnEnd).toBe(6);
  });

  test("returns matches across multiple rows in row order", () => {
    const rows: DiffRow[] = [
      stack("first hit", "a", 0),
      stack("no joy", "b", 1),
      stack("second hit", "c", 2),
    ];
    const matches = findSearchMatches(rows, "hit");
    expect(matches.map((m) => ({ fileId: m.fileId, rowIndex: m.rowIndex }))).toEqual([
      { fileId: "a", rowIndex: 0 },
      { fileId: "c", rowIndex: 2 },
    ]);
  });
});

describe("findMatchesInFiles", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " unchanged context",
    "-removed old line",
    "+added new line",
    "+another new line",
    "",
  ].join("\n");

  test("returns matches with file/side/line coordinates", () => {
    const file = fileWithPatch("a", "src/foo.ts", patch);
    const matches = findMatchesInFiles([file], "new");
    expect(matches).toEqual([
      {
        fileId: "a",
        filePath: "src/foo.ts",
        hunkIndex: 0,
        side: "new",
        line: 2,
        columnStart: 6,
        columnEnd: 9,
      },
      {
        fileId: "a",
        filePath: "src/foo.ts",
        hunkIndex: 0,
        side: "new",
        line: 3,
        columnStart: 8,
        columnEnd: 11,
      },
    ]);
  });

  test("attributes deletion lines to the old side with old line numbers", () => {
    const file = fileWithPatch("a", "src/foo.ts", patch);
    const matches = findMatchesInFiles([file], "removed");
    expect(matches).toEqual([
      {
        fileId: "a",
        filePath: "src/foo.ts",
        hunkIndex: 0,
        side: "old",
        line: 2,
        columnStart: 0,
        columnEnd: 7,
      },
    ]);
  });

  test("returns empty for empty query", () => {
    const file = fileWithPatch("a", "src/foo.ts", patch);
    expect(findMatchesInFiles([file], "")).toEqual([]);
  });

  test("walks every file in stream order", () => {
    const a = fileWithPatch(
      "a",
      "a.ts",
      ["@@ -1 +1 @@", "-target old", "+target new", ""].join("\n"),
    );
    const b = fileWithPatch(
      "b",
      "b.ts",
      ["@@ -1 +1 @@", "-target old", "+target new", ""].join("\n"),
    );
    const matches = findMatchesInFiles([a, b], "target");
    expect(matches.map((m) => m.fileId)).toEqual(["a", "a", "b", "b"]);
  });

  test("case-insensitive by default", () => {
    const file = fileWithPatch("a", "a.ts", ["@@ -1 +1 @@", "+Hello World", ""].join("\n"));
    expect(findMatchesInFiles([file], "hello")).toHaveLength(1);
    expect(findMatchesInFiles([file], "hello", { caseSensitive: true })).toEqual([]);
  });

  test("handles multiple hunks with separate line counters", () => {
    const multi = [
      "@@ -10,2 +10,2 @@",
      " context first",
      "+hit first",
      "@@ -100,2 +100,2 @@",
      " context second",
      "+hit second",
      "",
    ].join("\n");
    const file = fileWithPatch("a", "a.ts", multi);
    const matches = findMatchesInFiles([file], "hit");
    expect(matches.map((m) => ({ hunkIndex: m.hunkIndex, line: m.line }))).toEqual([
      { hunkIndex: 0, line: 11 },
      { hunkIndex: 1, line: 101 },
    ]);
  });

  test("skips file header lines and no-newline markers", () => {
    const noisy = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const file = fileWithPatch("a", "foo.ts", noisy);
    const matches = findMatchesInFiles([file], "line");
    expect(matches.map((m) => m.side)).toEqual(["old", "new"]);
  });
});

describe("moveSearchCursor", () => {
  test("returns -1 for an empty match list", () => {
    expect(moveSearchCursor(0, 0, 1)).toBe(-1);
    expect(moveSearchCursor(0, -1, -1)).toBe(-1);
  });

  test("forward wraps past the last index", () => {
    expect(moveSearchCursor(3, 2, 1)).toBe(0);
  });

  test("backward wraps past zero", () => {
    expect(moveSearchCursor(3, 0, -1)).toBe(2);
  });

  test("forward from uninitialized (-1) lands on first match", () => {
    expect(moveSearchCursor(3, -1, 1)).toBe(0);
  });

  test("backward from uninitialized (-1) lands on last match", () => {
    expect(moveSearchCursor(3, -1, -1)).toBe(2);
  });

  test("normal step inside the list", () => {
    expect(moveSearchCursor(5, 2, 1)).toBe(3);
    expect(moveSearchCursor(5, 2, -1)).toBe(1);
  });
});
