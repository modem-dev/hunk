import { describe, expect, test } from "bun:test";
import type { ExtensionFileViewLayout } from "../../extension-api/types";
import { measureAgentInlineNoteHeight } from "../components/panes/AgentInlineNote";
import { createVisibleAgentNote } from "../lib/agentAnnotations";
import { measureFileViewGeometry } from "./geometry";
import { validateFileViewLayout } from "./layout";
import { buildFileViewRenderPlan } from "./renderPlan";

describe("file-view geometry", () => {
  test("uses declared component heights while retaining stable row ids and hunk bounds", () => {
    const layout: ExtensionFileViewLayout = {
      rows: [
        { id: "intro", spans: [{ text: "intro" }] },
        {
          id: "custom-a",
          spans: [{ text: "custom fallback" }],
          component: { height: 3, render: () => null },
        },
        {
          id: "custom-b",
          spans: [{ text: "custom fallback" }],
          component: { height: 2, render: () => null },
        },
      ],
      hunkRows: [
        { startRow: 0, endRow: 1 },
        { startRow: 2, endRow: 2 },
      ],
    };

    const checked = validateFileViewLayout(layout, 2, 80);
    if (!checked.valid) throw new Error(checked.issue);
    const geometry = measureFileViewGeometry({
      resolved: checked.value,
      plannedRows: buildFileViewRenderPlan(checked.value.layout, []).rows,
      width: 80,
    });

    expect(geometry.rowBounds.map((row) => row.height)).toEqual([...checked.value.rowHeights]);
    expect(geometry.bodyHeight).toBe(6);
    expect(
      geometry.rowBounds.map(({ stableKey, top, height }) => ({
        stableKey,
        top,
        height,
      })),
    ).toEqual([
      { stableKey: "file-view:intro", top: 0, height: 1 },
      { stableKey: "file-view:custom-a", top: 1, height: 3 },
      { stableKey: "file-view:custom-b", top: 4, height: 2 },
    ]);
    expect(geometry.hunkAnchorRows).toEqual(
      new Map([
        [0, 0],
        [1, 4],
      ]),
    );
    expect(geometry.hunkBounds.get(0)).toMatchObject({ top: 0, height: 4 });
    expect(geometry.hunkBounds.get(1)).toMatchObject({ top: 4, height: 2 });
  });

  test("measures 10,000 rows and hunks through linear retained extents", () => {
    const checked = validateFileViewLayout(
      {
        rows: Array.from({ length: 10_000 }, (_, index) => ({
          id: `row-${index}`,
          spans: [{ text: `${index}` }],
        })),
        hunkRows: Array.from({ length: 10_000 }, (_, index) => ({
          startRow: index,
          endRow: index,
        })),
      },
      10_000,
      80,
    );
    if (!checked.valid) throw new Error(checked.issue);
    const geometry = measureFileViewGeometry({
      resolved: checked.value,
      plannedRows: buildFileViewRenderPlan(checked.value.layout, []).rows,
      width: 80,
    });

    expect(geometry.bodyHeight).toBe(10_000);
    expect(geometry.hunkAnchorRows.get(9_999)).toBe(9_999);
    expect(geometry.hunkBounds.get(9_999)).toMatchObject({ top: 9_999, height: 1 });
  });

  test("measures host notes and underlying rows from one planned stream", () => {
    const checked = validateFileViewLayout(
      {
        rows: [
          {
            id: "summary",
            spans: [{ text: "summary" }],
            sourceRanges: [{ side: "new", range: [1, 2] }],
            component: { height: 2, render: () => null },
          },
        ],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      1,
      80,
    );
    if (!checked.valid) throw new Error(checked.issue);
    const annotation = {
      id: "note",
      summary: "Review this range",
      newRange: [1, 1] as [number, number],
    };
    const plan = buildFileViewRenderPlan(checked.value.layout, [
      createVisibleAgentNote([], { id: "note", annotation }),
    ]);
    const noteHeight = measureAgentInlineNoteHeight({
      annotation,
      anchorSide: "new",
      layout: "stack",
      width: 80,
    });
    const geometry = measureFileViewGeometry({
      resolved: checked.value,
      plannedRows: plan.rows,
      width: 80,
    });

    expect(geometry.fileViewRows).toBe(plan.rows);
    expect(geometry.rowBounds.map((row) => row.height)).toEqual([2, noteHeight]);
    expect(geometry.bodyHeight).toBe(noteHeight + 2);
    expect(geometry.hunkAnchorRows.get(0)).toBe(0);
    expect(geometry.hunkBounds.get(0)).toMatchObject({ top: 0, height: noteHeight + 2 });
  });

  test("indexes every navigable row under the source line the review stream reveals it by", () => {
    const checked = validateFileViewLayout(
      {
        rows: [
          {
            id: "summary",
            spans: [{ text: "hunk 1" }],
            sourceRanges: [{ side: "new", range: [1, 1] }],
          },
          { id: "detail", spans: [{ text: "detail" }] },
        ],
        hunkRows: [{ startRow: 0, endRow: 1 }],
      },
      1,
      80,
    );
    if (!checked.valid) throw new Error(checked.issue);

    const plan = buildFileViewRenderPlan(checked.value.layout, []);
    const geometry = measureFileViewGeometry({
      resolved: checked.value,
      plannedRows: plan.rows,
      width: 80,
    });

    expect(geometry.rowBoundsByStableKey.get("line:0:new:1")).toMatchObject({ top: 0 });
    expect(geometry.rowBoundsByStableKey.get("file-view:summary")).toMatchObject({ top: 0 });
  });
});
