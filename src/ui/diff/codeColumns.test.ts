import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/types";
import { findMaxLineNumberInRows, maxFileCodeLineWidth } from "./codeColumns";
import type { DiffRow } from "./pierre";

/** Generate a large diff metadata fixture without checking a huge file into the repo. */
function createLargeLineFixture(lineCount: number, widestLine: string): DiffFile {
  const additionLines = Array.from({ length: lineCount }, (_, index) =>
    index === lineCount - 1 ? widestLine : "x",
  );

  return {
    agent: null,
    id: "large-untracked",
    metadata: {
      additionLines,
      deletionLines: [],
      hunks: [],
    } as unknown as DiffFile["metadata"],
    patch: "",
    path: "large-untracked.txt",
    stats: { additions: lineCount, deletions: 0 },
  };
}

describe("code column measurement", () => {
  test("measures large generated fixtures without overflowing the call stack", () => {
    const file = createLargeLineFixture(100_000, "the widest generated line");

    expect(maxFileCodeLineWidth(file)).toBe("the widest generated line".length);
  });
});

describe("findMaxLineNumberInRows", () => {
  test("accounts for collapsed gap ranges that can later expand", () => {
    const rows: DiffRow[] = [
      {
        type: "split-line",
        key: "file:line:0",
        fileId: "file",
        hunkIndex: 0,
        left: { kind: "deletion", sign: "-", lineNumber: 5, spans: [{ text: "old" }] },
        right: { kind: "addition", sign: "+", lineNumber: 5, spans: [{ text: "new" }] },
      },
      {
        type: "collapsed",
        key: "file:collapsed:trailing",
        fileId: "file",
        hunkIndex: 0,
        oldRange: [6, 1000],
        newRange: [6, 1000],
        position: "trailing",
        text: "995 unchanged lines",
      },
    ];

    expect(findMaxLineNumberInRows(rows)).toBe(1000);
  });

  test("accounts for synthesized stack expansion rows", () => {
    const rows: DiffRow[] = [
      {
        type: "stack-line",
        key: "file:expanded:trailing:0:0",
        fileId: "file",
        hunkIndex: 0,
        isExpansionRow: true,
        cell: {
          kind: "context",
          sign: " ",
          oldLineNumber: 998,
          newLineNumber: 1002,
          spans: [{ text: "context" }],
        },
      },
    ];

    expect(findMaxLineNumberInRows(rows, 9)).toBe(1002);
  });
});
