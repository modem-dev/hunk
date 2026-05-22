import { describe, expect, test } from "bun:test";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import { reviewRowId } from "../lib/ids";
import type { PlannedReviewRow } from "./reviewRenderPlan";
import {
  measurePlannedSectionGeometry,
  plannedReviewRowHeight,
  plannedReviewRowVisible,
} from "./plannedReviewRows";

const baseOptions = {
  showHunkHeaders: true,
  layout: "split",
  width: 100,
} as const;

function hunkHeader(key: string, hunkIndex: number, anchorId?: string): PlannedReviewRow {
  return {
    kind: "diff-row",
    key,
    stableKey: key,
    fileId: "file-1",
    hunkIndex,
    anchorId,
    row: {
      type: "hunk-header",
      key,
      fileId: "file-1",
      hunkIndex,
      text: "@@ -1,1 +1,1 @@",
    },
  };
}

function collapsedRow(key: string, hunkIndex: number): PlannedReviewRow {
  return {
    kind: "diff-row",
    key,
    stableKey: key,
    fileId: "file-1",
    hunkIndex,
    row: {
      type: "collapsed",
      key,
      fileId: "file-1",
      hunkIndex,
      text: "⋯",
    },
  };
}

function splitLine(key: string, hunkIndex: number, anchorId?: string): PlannedReviewRow {
  return {
    kind: "diff-row",
    key,
    stableKey: key,
    fileId: "file-1",
    hunkIndex,
    anchorId,
    row: {
      type: "split-line",
      key,
      fileId: "file-1",
      hunkIndex,
      left: {
        kind: "deletion",
        sign: "-",
        lineNumber: 1,
        spans: [{ text: "old" }],
      },
      right: {
        kind: "addition",
        sign: "+",
        lineNumber: 1,
        spans: [{ text: "new" }],
      },
    },
  };
}

function inlineNote(key: string, hunkIndex: number): PlannedReviewRow {
  const annotation = {
    id: "note-1",
    newRange: [1, 1] as [number, number],
    summary: "Explain why this branch changed.",
    rationale: "The note should reserve space in the hunk bounds.",
  };
  const note: VisibleAgentNote = { id: "note-1", annotation };

  return {
    kind: "inline-note",
    key,
    stableKey: key,
    fileId: "file-1",
    hunkIndex,
    annotationId: "note-1",
    annotation,
    note,
    anchorSide: "new",
    noteCount: 1,
    noteIndex: 0,
  };
}

function guidedLine(key: string, hunkIndex: number): PlannedReviewRow {
  const row = splitLine(key, hunkIndex) as Extract<PlannedReviewRow, { kind: "diff-row" }>;
  return {
    ...row,
    noteGuideSide: "new",
  };
}

describe("planned review row geometry", () => {
  test("row height and visibility match the terminal rows each planned row renders", () => {
    expect(plannedReviewRowHeight(hunkHeader("header", 0), baseOptions)).toBe(1);
    expect(
      plannedReviewRowHeight(hunkHeader("header", 0), {
        ...baseOptions,
        showHunkHeaders: false,
      }),
    ).toBe(0);
    expect(
      plannedReviewRowVisible(hunkHeader("header", 0), {
        ...baseOptions,
        showHunkHeaders: false,
      }),
    ).toBe(false);
    expect(plannedReviewRowHeight(splitLine("line", 0), baseOptions)).toBe(1);
    expect(plannedReviewRowHeight(guidedLine("guide", 0), baseOptions)).toBe(1);
    expect(plannedReviewRowHeight(inlineNote("note", 0), baseOptions)).toBeGreaterThan(3);
  });

  test("measured hunk bounds ignore collapsed gaps but include inline notes and guide rows", () => {
    const rows = [
      hunkHeader("h0", 0, "hunk-0"),
      splitLine("line-0", 0),
      collapsedRow("gap", 0),
      inlineNote("note", 0),
      guidedLine("guide", 0),
      hunkHeader("h1", 1, "hunk-1"),
      splitLine("line-1", 1),
    ];

    const measured = measurePlannedSectionGeometry(rows, baseOptions);
    const noteHeight = plannedReviewRowHeight(rows[3]!, baseOptions);

    expect(measured.bodyHeight).toBe(6 + noteHeight);
    expect(measured.hunkAnchorRows.get(0)).toBe(0);
    expect(measured.hunkAnchorRows.get(1)).toBe(4 + noteHeight);
    expect(measured.hunkBounds.get(0)).toEqual({
      top: 0,
      height: 3 + noteHeight,
      startRowId: reviewRowId("h0"),
      endRowId: reviewRowId("guide"),
    });
    expect(measured.hunkBounds.get(1)).toEqual({
      top: 4 + noteHeight,
      height: 2,
      startRowId: reviewRowId("h1"),
      endRowId: reviewRowId("line-1"),
    });
  });

  test("hidden hunk headers can anchor navigation without widening visible hunk bounds", () => {
    const rows = [hunkHeader("h0", 0, "hunk-0"), splitLine("line-0", 0)];

    const measured = measurePlannedSectionGeometry(rows, {
      ...baseOptions,
      showHunkHeaders: false,
    });

    expect(measured.bodyHeight).toBe(1);
    expect(measured.hunkAnchorRows.get(0)).toBe(0);
    expect(measured.hunkBounds.get(0)).toEqual({
      top: 0,
      height: 1,
      startRowId: reviewRowId("line-0"),
      endRowId: reviewRowId("line-0"),
    });
  });
});
