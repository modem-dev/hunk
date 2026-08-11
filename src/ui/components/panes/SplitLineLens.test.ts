import { describe, expect, test } from "bun:test";
import type { DiffRow } from "../../diff/pierre";
import { buildSplitLineLensRows, indexSplitRowsByStableKey } from "./SplitLineLens";

type SplitLineRow = Extract<DiffRow, { type: "split-line" }>;

/** Build one paired replacement row for lens adaptation tests. */
function createSplitLineRow(): SplitLineRow {
  return {
    type: "split-line",
    key: "row-1",
    fileId: "sample",
    hunkIndex: 0,
    left: {
      kind: "deletion",
      sign: "-",
      lineNumber: 4,
      spans: [{ text: "const value = 1;", fg: "#ffffff" }],
    },
    right: {
      kind: "addition",
      sign: "+",
      lineNumber: 6,
      spans: [{ text: "const value = 2;", bg: "#123456" }],
    },
  };
}

describe("split-line lens rows", () => {
  test("places the old version above the new version without losing highlighted spans", () => {
    const [oldRow, newRow] = buildSplitLineLensRows(createSplitLineRow());

    expect(oldRow.cell).toEqual({
      kind: "deletion",
      sign: "-",
      oldLineNumber: 4,
      spans: [{ text: "const value = 1;", fg: "#ffffff" }],
    });
    expect(newRow.cell).toEqual({
      kind: "addition",
      sign: "+",
      newLineNumber: 6,
      spans: [{ text: "const value = 2;", bg: "#123456" }],
    });
  });

  test("indexes both sides of a split row for constant-time cursor movement", () => {
    const row = createSplitLineRow();
    const indexed = indexSplitRowsByStableKey([
      {
        kind: "diff-row",
        key: row.key,
        stableKey: "line:0:old:4",
        stableAliasKeys: ["line:0:new:6"],
        fileId: row.fileId,
        hunkIndex: row.hunkIndex,
        row,
      },
    ]);

    expect(indexed.get("line:0:old:4")).toBe(row);
    expect(indexed.get("line:0:new:6")).toBe(row);
  });

  test("keeps an absent side as an explicit blank lens row", () => {
    const row = createSplitLineRow();
    row.left = { kind: "empty", sign: " ", spans: [] };

    const [oldRow] = buildSplitLineLensRows(row);

    expect(oldRow.cell).toEqual({ kind: "context", sign: " ", spans: [] });
  });
});
