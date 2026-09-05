import { describe, expect, test } from "bun:test";
import type { DiffSectionGeometry } from "./diffSectionGeometry";
import type { PlannedReviewRow } from "./reviewRenderPlan";
import { resolveVisiblePlannedRowWindow, resolveVisibleRowIndexWindow } from "./rowWindowing";

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
  const plannedRows = rowBounds.map((row) => createTestPlannedRow(row.key));
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
    plannedRows,
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

  test("bounds indexed geometry access for a 10,000-row alternate layout", () => {
    const source = Array.from({ length: 10_000 }, (_, index) => ({
      key: `row:${index}`,
      stableKey: `row:${index}`,
      stableKeys: [`row:${index}`],
      top: index * 2,
      height: 2,
    }));
    let indexedAccesses = 0;
    const rowBounds = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) indexedAccesses += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const window = resolveVisibleRowIndexWindow({
      bodyHeight: 20_000,
      rowBounds,
      visibleBodyBounds: { top: 12_000, height: 10 },
    });

    expect(window.endIndex - window.startIndex).toBe(5);
    expect(indexedAccesses).toBeLessThan(80);
    const mountedHeight = source
      .slice(window.startIndex, window.endIndex)
      .reduce((sum, row) => sum + row.height, 0);
    expect(window.topSpacerHeight + mountedHeight + window.bottomSpacerHeight).toBe(20_000);
  });

  test("finds visible rows in a very large row-bound array", () => {
    const rowBounds = Array.from({ length: 50_000 }, (_, index) => ({
      key: `row:${index}`,
      top: index,
      height: 1,
    }));
    const plannedRows = rowBounds.map((row) => createTestPlannedRow(row.key));
    const sectionGeometry = createTestSectionGeometry(rowBounds, rowBounds.length);

    const window = resolveVisiblePlannedRowWindow({
      plannedRows,
      sectionGeometry,
      visibleBodyBounds: { top: 30_000, height: 5 },
    });

    expect(window.topSpacerHeight).toBe(30_000);
    expect(window.bottomSpacerHeight).toBe(19_995);
    expect(window.plannedRows.map((row) => row.key)).toEqual([
      "row:30000",
      "row:30001",
      "row:30002",
      "row:30003",
      "row:30004",
    ]);
  });
});
