import { describe, expect, test } from "bun:test";
import { resolveCodeRowNoteTarget } from "./codeRowAffordance";
import type { CodeDiffRow } from "./reviewRenderPlan";

/** Build a split code row with independently optional line numbers. */
function splitRow(leftLine?: number, rightLine?: number): CodeDiffRow {
  return {
    type: "split-line",
    key: "split",
    fileId: "file",
    hunkIndex: 2,
    left: {
      kind: leftLine === undefined ? "empty" : "deletion",
      sign: leftLine === undefined ? " " : "-",
      lineNumber: leftLine,
      spans: [],
    },
    right: {
      kind: rightLine === undefined ? "empty" : "addition",
      sign: rightLine === undefined ? " " : "+",
      lineNumber: rightLine,
      spans: [],
    },
  };
}

/** Build a stack code row with independently optional old and new line numbers. */
function stackRow(oldLine?: number, newLine?: number): CodeDiffRow {
  return {
    type: "stack-line",
    key: "stack",
    fileId: "file",
    hunkIndex: 2,
    cell: {
      kind: "context",
      sign: " ",
      oldLineNumber: oldLine,
      newLineNumber: newLine,
      spans: [],
    },
  };
}

describe("resolveCodeRowNoteTarget", () => {
  test("prefers the new side for split and stack rows", () => {
    expect(resolveCodeRowNoteTarget(splitRow(10, 20))).toEqual({ side: "new", line: 20 });
    expect(resolveCodeRowNoteTarget(stackRow(10, 20))).toEqual({ side: "new", line: 20 });
  });

  test("falls back to the old side for deleted lines", () => {
    expect(resolveCodeRowNoteTarget(splitRow(10))).toEqual({ side: "old", line: 10 });
    expect(resolveCodeRowNoteTarget(stackRow(10))).toEqual({ side: "old", line: 10 });
  });

  test("returns no target when neither side has a line", () => {
    expect(resolveCodeRowNoteTarget(splitRow())).toBeUndefined();
    expect(resolveCodeRowNoteTarget(stackRow())).toBeUndefined();
  });
});
