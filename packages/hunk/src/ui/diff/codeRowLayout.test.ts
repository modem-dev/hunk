import { describe, expect, test } from "bun:test";
import { CODE_ROW_ADD_NOTE_BADGE_WIDTH } from "./codeRowAffordance";
import type { DiffRow, SplitLineCell, StackLineCell } from "./diffRows";
import {
  measurePlannedRenderedRowHeight,
  planCodeRowLayout,
  type CodeRowLayoutOptions,
} from "./codeRowLayout";
import { renderDecoratedPlannedRowText } from "./plannedRowText";
import type { PlannedReviewRow } from "./reviewRenderPlan";

const boundaryText = "1234567";
type PlannedDiffRow = Extract<PlannedReviewRow, { kind: "diff-row" }>;

/** Build one complete planned split row for width-boundary layout tests. */
function splitPlannedRow(noteGuideSide?: "old" | "new"): PlannedDiffRow {
  const empty: SplitLineCell = { kind: "empty", sign: " ", spans: [] };
  const addition: SplitLineCell = {
    kind: "addition",
    sign: "+",
    lineNumber: 1,
    spans: [{ text: boundaryText }],
  };
  const row: DiffRow = {
    type: "split-line",
    key: "file:split:1",
    fileId: "file",
    hunkIndex: 0,
    left: empty,
    right: addition,
  };
  return {
    kind: "diff-row",
    key: row.key,
    stableKey: row.key,
    fileId: row.fileId,
    hunkIndex: row.hunkIndex,
    row,
    noteGuideSide,
  };
}

/** Build one complete planned stack row for width-boundary layout tests. */
function stackPlannedRow(noteGuideSide?: "old" | "new"): PlannedDiffRow {
  const cell: StackLineCell = {
    kind: "addition",
    sign: "+",
    newLineNumber: 1,
    spans: [{ text: boundaryText }],
  };
  const row: DiffRow = {
    type: "stack-line",
    key: "file:stack:1",
    fileId: "file",
    hunkIndex: 0,
    cell,
  };
  return {
    kind: "diff-row",
    key: row.key,
    stableKey: row.key,
    fileId: row.fileId,
    hunkIndex: row.hunkIndex,
    row,
    noteGuideSide,
  };
}

/** Render decorated text with the same concrete options used by the sizing planner. */
function decoratedLines(row: PlannedReviewRow, options: CodeRowLayoutOptions) {
  return renderDecoratedPlannedRowText(row, {
    ...options,
    codeHorizontalOffset: 0,
    showHunkHeaders: true,
  });
}

describe("planned code-row layout", () => {
  test("split measurement and decorated rendering reserve a new-side guide at an exact wrap boundary", () => {
    const options = {
      width: 20,
      lineNumberDigits: 1,
      showLineNumbers: false,
      wrapLines: true,
    } as const;
    const unguided = splitPlannedRow();
    const guided = splitPlannedRow("new");

    expect(planCodeRowLayout(unguided, options)).toMatchObject({
      kind: "split",
      right: { contentWidth: 7, wrappedLineCount: 1 },
      trailingGuideWidth: 0,
      wrappedLineCount: 1,
    });
    expect(planCodeRowLayout(guided, options)).toMatchObject({
      kind: "split",
      right: { contentWidth: 6, wrappedLineCount: 2 },
      trailingGuideWidth: 1,
      wrappedLineCount: 2,
    });
    expect(measurePlannedRenderedRowHeight(guided, { ...options, showHunkHeaders: true })).toBe(2);
    expect(decoratedLines(guided, options)).toHaveLength(2);
    expect(decoratedLines(guided, options).every((line) => line.endsWith("│"))).toBe(true);
  });

  test("stack measurement and decorated rendering reserve a new-side guide at an exact wrap boundary", () => {
    const options = {
      width: 10,
      lineNumberDigits: 1,
      showLineNumbers: false,
      wrapLines: true,
    } as const;
    const unguided = stackPlannedRow();
    const guided = stackPlannedRow("new");

    expect(planCodeRowLayout(unguided, options)).toMatchObject({
      kind: "stack",
      cell: { contentWidth: 7, wrappedLineCount: 1 },
      trailingGuideWidth: 0,
      wrappedLineCount: 1,
    });
    expect(planCodeRowLayout(guided, options)).toMatchObject({
      kind: "stack",
      cell: { contentWidth: 6, wrappedLineCount: 2 },
      trailingGuideWidth: 1,
      wrappedLineCount: 2,
    });
    expect(measurePlannedRenderedRowHeight(guided, { ...options, showHunkHeaders: true })).toBe(2);
    expect(decoratedLines(guided, options)).toHaveLength(2);
    expect(decoratedLines(guided, options).every((line) => line.endsWith("│"))).toBe(true);
  });

  test("memoizes wrapped measurement while preserving lazy plan construction", () => {
    for (const row of [splitPlannedRow(), stackPlannedRow()]) {
      if (row.row.type !== "split-line" && row.row.type !== "stack-line") {
        throw new Error("expected a code row");
      }
      const spans = row.row.type === "split-line" ? row.row.right.spans : row.row.cell.spans;
      const span = spans[0]!;
      let textReads = 0;
      Object.defineProperty(span, "text", {
        configurable: true,
        get() {
          textReads += 1;
          return boundaryText;
        },
      });

      const plan = planCodeRowLayout(row, {
        width: row.row.type === "split-line" ? 20 : 10,
        lineNumberDigits: 1,
        showLineNumbers: false,
        wrapLines: true,
      });
      expect(plan).not.toBeNull();
      expect(textReads).toBe(0);

      expect(plan!.wrappedLineCount).toBe(1);
      const readsAfterMeasurement = textReads;
      expect(readsAfterMeasurement).toBeGreaterThan(0);
      expect(plan!.wrappedLineCount).toBe(1);
      expect(
        plan!.kind === "split" ? plan!.right.wrappedLineCount : plan!.cell.wrappedLineCount,
      ).toBe(1);
      expect(textReads).toBe(readsAfterMeasurement);
    }
  });

  test("guide, badge, and wrapping policies reserve the same total width in split and stack", () => {
    for (const rowFactory of [splitPlannedRow, stackPlannedRow]) {
      for (const noteGuideSide of [undefined, "old", "new"] as const) {
        for (const wrapLines of [false, true]) {
          for (const reserveAddNoteColumn of [false, true]) {
            for (const showAddNoteBadge of [false, true]) {
              const options = {
                width: 20,
                lineNumberDigits: 2,
                showLineNumbers: true,
                wrapLines,
                reserveAddNoteColumn,
                showAddNoteBadge,
              };
              const plan = planCodeRowLayout(rowFactory(noteGuideSide), options);
              expect(plan).not.toBeNull();
              if (!plan) {
                continue;
              }

              const expectedBadgeWidth =
                showAddNoteBadge || (wrapLines && reserveAddNoteColumn)
                  ? CODE_ROW_ADD_NOTE_BADGE_WIDTH
                  : 0;
              expect(plan.addNoteBadgeWidth).toBe(expectedBadgeWidth);
              expect(plan.trailingGuideWidth).toBe(noteGuideSide === "new" ? 1 : 0);

              const reservedWidth = plan.trailingGuideWidth + plan.addNoteBadgeWidth;
              if (plan.kind === "split") {
                expect(plan.left.width + plan.right.width + reservedWidth).toBe(options.width);
                expect(plan.left.prefixWidth).toBe(1);
                expect(plan.right.prefixWidth).toBe(1);
              } else {
                expect(plan.cell.width + reservedWidth).toBe(options.width);
                expect(plan.cell.prefixWidth).toBe(1);
              }
            }
          }
        }
      }
    }
  });
});
