import { describe, expect, test } from "bun:test";
import type { DiffSectionGeometry } from "./diffSectionGeometry";
import type { PlannedReviewRow } from "./reviewRenderPlan";
import { resolveVisiblePlannedRowWindow } from "./rowWindowing";

/** Build one minimal planned row for row-window slicing tests. */
function createTestPlannedRow(key: string): PlannedReviewRow {
  return {
    kind: "diff-row",
    key,
    stableKey: key,
    fileId: "file:test",
    hunkIndex: 0,
    row: {
      type: "hunk-header",
      key,
      fileId: "file:test",
      hunkIndex: 0,
      text: key,
    },
  };
}

/** Build one geometry object with explicit row bounds for row-window tests. */
function createTestSectionGeometry(
  rowBounds: Array<{ key: string; top: number; height: number }>,
  bodyHeight: number,
): DiffSectionGeometry {
  const normalizedRowBounds = rowBounds.map((row) => ({
    ...row,
    stableKey: row.key,
    stableKeys: [row.key],
  }));

  return {
    bodyHeight,
    hunkAnchorRows: new Map(),
    hunkBounds: new Map(),
    lineNumberDigits: 1,
    plannedRows: rowBounds.map((row) => createTestPlannedRow(row.key)),
    rowBounds: normalizedRowBounds,
    rowBoundsByKey: new Map(normalizedRowBounds.map((row) => [row.key, row])),
    rowBoundsByStableKey: new Map(normalizedRowBounds.map((row) => [row.stableKey, row])),
  };
}

describe("resolveVisiblePlannedRowWindow", () => {
  test("returns only rows that intersect the visible body range", () => {
    const plannedRows = ["row:0", "row:1", "row:2", "row:3"].map(createTestPlannedRow);
    const sectionGeometry = createTestSectionGeometry(
      [
        { key: "row:0", top: 0, height: 1 },
        { key: "row:1", top: 1, height: 2 },
        { key: "row:2", top: 3, height: 1 },
        { key: "row:3", top: 4, height: 1 },
      ],
      5,
    );

    const window = resolveVisiblePlannedRowWindow({
      plannedRows,
      sectionGeometry,
      visibleBodyBounds: { top: 1, height: 3 },
    });

    expect(window.topSpacerHeight).toBe(1);
    expect(window.bottomSpacerHeight).toBe(1);
    expect(window.plannedRows.map((row) => row.key)).toEqual(["row:1", "row:2"]);
  });

  test("keeps adjacent zero-height rows attached to the visible slice", () => {
    const plannedRows = ["header:hidden", "code:1", "header:hidden:after", "code:2"].map(
      createTestPlannedRow,
    );
    const sectionGeometry = createTestSectionGeometry(
      [
        { key: "header:hidden", top: 0, height: 0 },
        { key: "code:1", top: 0, height: 1 },
        { key: "header:hidden:after", top: 1, height: 0 },
        { key: "code:2", top: 1, height: 1 },
      ],
      2,
    );

    const window = resolveVisiblePlannedRowWindow({
      plannedRows,
      sectionGeometry,
      visibleBodyBounds: { top: 0, height: 1 },
    });

    expect(window.topSpacerHeight).toBe(0);
    expect(window.bottomSpacerHeight).toBe(1);
    expect(window.plannedRows.map((row) => row.key)).toEqual([
      "header:hidden",
      "code:1",
      "header:hidden:after",
    ]);
  });

  test("can collapse a fully offscreen file body above the viewport into top spacer height", () => {
    const plannedRows = ["row:0", "row:1"].map(createTestPlannedRow);
    const sectionGeometry = createTestSectionGeometry(
      [
        { key: "row:0", top: 0, height: 2 },
        { key: "row:1", top: 2, height: 2 },
      ],
      4,
    );

    const window = resolveVisiblePlannedRowWindow({
      plannedRows,
      sectionGeometry,
      visibleBodyBounds: { top: 10, height: 2 },
    });

    expect(window.topSpacerHeight).toBe(4);
    expect(window.bottomSpacerHeight).toBe(0);
    expect(window.plannedRows).toHaveLength(0);
  });

  test("can collapse a fully offscreen file body below the viewport into bottom spacer height", () => {
    const plannedRows = ["row:0", "row:1"].map(createTestPlannedRow);
    const sectionGeometry = createTestSectionGeometry(
      [
        { key: "row:0", top: 0, height: 2 },
        { key: "row:1", top: 2, height: 2 },
      ],
      4,
    );

    const window = resolveVisiblePlannedRowWindow({
      plannedRows,
      sectionGeometry,
      visibleBodyBounds: { top: 0, height: 0 },
    });

    expect(window.topSpacerHeight).toBe(0);
    expect(window.bottomSpacerHeight).toBe(4);
    expect(window.plannedRows).toHaveLength(0);
  });
});
