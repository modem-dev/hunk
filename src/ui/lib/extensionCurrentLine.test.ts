import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { buildDiffSectionRowPlan } from "../diff/diffSectionRowPlan";
import { resolveTheme } from "../themes";
import { createExtensionCurrentLinePaint } from "./extensionCurrentLine";
import type { LineCursor } from "./lineCursors";

/** Build one accepted split row plan and a cursor that resolves inside it. */
function splitPlanFixture() {
  const file = createTestDiffFile({
    id: "alpha",
    path: "alpha.ts",
    before: "const value = 1;\n",
    after: "const value = 222;\n",
  });
  const theme = resolveTheme("github-dark-default", null);
  const rowPlan = buildDiffSectionRowPlan({
    file,
    highlightedDiff: null,
    layout: "split",
    showHunkHeaders: true,
    theme,
  });
  const planned = rowPlan.plannedRows.find(
    (row) => row.kind === "diff-row" && row.row.type === "split-line",
  );
  if (!planned || planned.kind !== "diff-row" || planned.row.type !== "split-line") {
    throw new Error("Expected a split row fixture.");
  }
  const cursor: LineCursor = {
    fileId: file.id,
    hunkIndex: planned.row.hunkIndex,
    stableKey: planned.stableKey,
    target: { side: "new", line: planned.row.right.lineNumber ?? 1 },
  };
  return { cursor, rowPlan, splitRow: planned.row, theme };
}

describe("extension current-line paint", () => {
  test("exposes only an opaque painter backed by the accepted row plan", () => {
    const fixture = splitPlanFixture();
    const paint = createExtensionCurrentLinePaint({
      ...fixture,
      showLineNumbers: true,
      codeHorizontalOffset: 0,
    });

    expect(paint).not.toBeNull();
    expect(Object.keys(paint!)).toEqual(["render"]);
    const oldPaint = paint!.render("old", 60) as {
      props: {
        row: { cell: Record<string, unknown> };
        width: number;
        showLineNumbers: boolean;
        codeHorizontalOffset: number;
      };
    };
    const newPaint = paint!.render("new", 60) as typeof oldPaint;

    expect(oldPaint.props.row.cell).toEqual({
      kind: fixture.splitRow.left.kind,
      sign: fixture.splitRow.left.sign,
      oldLineNumber: fixture.splitRow.left.lineNumber,
      spans: fixture.splitRow.left.spans,
    });
    expect(newPaint.props.row.cell).toEqual({
      kind: fixture.splitRow.right.kind,
      sign: fixture.splitRow.right.sign,
      newLineNumber: fixture.splitRow.right.lineNumber,
      spans: fixture.splitRow.right.spans,
    });
    expect(oldPaint.props.width).toBe(60);
    expect(oldPaint.props.showLineNumbers).toBe(true);
    expect(oldPaint.props.codeHorizontalOffset).toBe(0);
  });

  test("preserves move paint and turns an absent side into an explicit blank row", () => {
    const fixture = splitPlanFixture();
    fixture.splitRow.left = { kind: "empty", sign: " ", spans: [] };
    fixture.splitRow.right.moveKind = "moved";
    const paint = createExtensionCurrentLinePaint({
      ...fixture,
      showLineNumbers: false,
      codeHorizontalOffset: 17,
    });
    const oldPaint = paint!.render("old", 42) as {
      props: { row: { cell: Record<string, unknown> }; codeHorizontalOffset: number };
    };
    const newPaint = paint!.render("new", 42) as typeof oldPaint;

    expect(oldPaint.props.row.cell).toEqual({ kind: "context", sign: " ", spans: [] });
    expect(newPaint.props.row.cell.moveKind).toBe("moved");
    expect(newPaint.props.codeHorizontalOffset).toBe(17);
  });

  test("returns null when the existing cursor does not resolve in that plan", () => {
    const fixture = splitPlanFixture();
    const paint = createExtensionCurrentLinePaint({
      ...fixture,
      cursor: { ...fixture.cursor, stableKey: "missing" },
      showLineNumbers: true,
      codeHorizontalOffset: 0,
    });

    expect(paint).toBeNull();
  });
});
