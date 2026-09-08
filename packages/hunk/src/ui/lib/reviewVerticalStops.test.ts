import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { measureDiffSectionGeometry, type DiffSectionGeometry } from "../diff/diffSectionGeometry";
import { createVisibleAgentNote } from "./agentAnnotations";
import { buildLineCursors, type LineCursor } from "./lineCursors";
import { resolveTheme } from "../themes";
import {
  buildReviewVerticalStops,
  createReviewVerticalStopStabilizer,
  findNextReviewNoteStop,
  findNextReviewVerticalStop,
} from "./reviewVerticalStops";

const theme = resolveTheme("github-dark-default", null);

/** Summarize mixed stops for ordering assertions. */
function stopLabel(stop: ReturnType<typeof buildReviewVerticalStops>[number]) {
  return stop.kind === "note"
    ? `note:${stop.noteId}`
    : `line:${stop.cursor.target.side}:${stop.cursor.target.line}`;
}

describe("review vertical stops", () => {
  test("places semantic roots and replies after their rendered source line", () => {
    const file = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("one", "two", "three", "four", "five"),
      after: lines("one", "two", "THREE", "four", "five"),
      context: 3,
    });
    const notes = [
      createVisibleAgentNote(file.metadata.hunks, {
        id: "root-card",
        annotation: { source: "user", summary: "root", newRange: [3, 3] },
        thread: { noteId: "root", depth: 0 },
      }),
      createVisibleAgentNote(file.metadata.hunks, {
        id: "reply-card",
        annotation: { source: "user", summary: "reply", newRange: [3, 3] },
        thread: { noteId: "reply", parentId: "root", depth: 1 },
      }),
      createVisibleAgentNote(file.metadata.hunks, {
        id: "sidecar-card",
        annotation: { source: "agent", summary: "decoration", newRange: [3, 3] },
      }),
      createVisibleAgentNote(file.metadata.hunks, {
        id: "draft-card",
        annotation: { source: "user-draft", summary: "draft", newRange: [3, 3] },
        source: "draft",
        thread: { noteId: "draft", depth: 0 },
      }),
    ];
    const geometry = measureDiffSectionGeometry(file, "unified", true, theme, notes, 80);
    const cursors = buildLineCursors([file], [geometry]);
    const stops = buildReviewVerticalStops([file], [geometry], cursors);
    const labels = stops.map(stopLabel);
    const changedLine = labels.indexOf("line:new:3");

    expect(labels.slice(changedLine, changedLine + 4)).toEqual([
      "line:new:3",
      "note:root",
      "note:reply",
      "line:new:4",
    ]);
    expect(labels).not.toContain("note:sidecar-card");
    expect(labels).not.toContain("note:draft");

    const root = stops[changedLine + 1]!;
    const reply = findNextReviewVerticalStop(stops, root, 1);
    expect(reply && stopLabel(reply)).toBe("note:reply");
    expect(stopLabel(findNextReviewVerticalStop(stops, reply, -1)!)).toBe("note:root");
    expect(findNextReviewVerticalStop(stops, stops[0]!, -1)).toBe(stops[0]!);
    expect(findNextReviewVerticalStop(stops, stops.at(-1)!, 1)).toBe(stops.at(-1)!);
    expect(findNextReviewVerticalStop(stops, null, -1)).toBe(stops.at(-1)!);
    expect(findNextReviewNoteStop(stops, stops[changedLine]!, 1)?.noteId).toBe("root");
    expect(findNextReviewNoteStop(stops, stops[changedLine + 3]!, -1)?.noteId).toBe("reply");
  });

  test("uses alternate file-view inline-note rows as selectable stops", () => {
    const file = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("one", "two"),
      after: lines("ONE", "two"),
      context: 1,
    });
    const first: LineCursor = {
      fileId: file.id,
      hunkIndex: 0,
      stableKey: "line:0:new:1",
      target: { side: "new", line: 1 },
    };
    const second: LineCursor = {
      fileId: file.id,
      hunkIndex: 0,
      stableKey: "line:0:context:2:2",
      target: { side: "new", line: 2 },
    };
    const note = createVisibleAgentNote(file.metadata.hunks, {
      id: "view-card",
      annotation: { source: "user", summary: "view note", newRange: [1, 1] },
      thread: { noteId: "view-note", depth: 0 },
    });
    const geometry = {
      bodyHeight: 3,
      hunkAnchorRows: new Map(),
      hunkBounds: new Map(),
      hunkSpans: file.metadata.hunks,
      lineNumberDigits: 1,
      plannedRows: [],
      fileViewRows: [
        {
          kind: "file-view-row",
          key: "row-1",
          stableKey: first.stableKey,
          row: { id: "1", spans: [] },
          rowIndex: 0,
        },
        {
          kind: "inline-note",
          key: "note",
          stableKey: "inline-note:view-card",
          annotation: note.annotation,
          anchorRowIndex: 0,
          anchorSide: "new",
          hunkIndex: 0,
          note,
          noteCount: 1,
          noteIndex: 0,
        },
        {
          kind: "file-view-row",
          key: "row-2",
          stableKey: second.stableKey,
          row: { id: "2", spans: [] },
          rowIndex: 1,
        },
      ],
      rowBounds: [
        {
          key: "row-1",
          stableKey: first.stableKey,
          stableKeys: [first.stableKey],
          top: 0,
          height: 1,
        },
        {
          key: "note",
          stableKey: "inline-note:view-card",
          stableKeys: ["inline-note:view-card"],
          top: 1,
          height: 1,
        },
        {
          key: "row-2",
          stableKey: second.stableKey,
          stableKeys: [second.stableKey],
          top: 2,
          height: 1,
        },
      ],
      rowBoundsByKey: new Map(),
      rowBoundsByStableKey: new Map(),
    } satisfies DiffSectionGeometry;

    const stops = buildReviewVerticalStops([file], [geometry], [first, second]);
    expect(stops.map(stopLabel)).toEqual(["line:new:1", "note:view-note", "line:new:2"]);
    expect(findNextReviewNoteStop(stops, stops[0]!, 1)?.noteId).toBe("view-note");
    expect(findNextReviewNoteStop(stops, stops[2]!, -1)?.noteId).toBe("view-note");
  });

  test("stabilizes equivalent remeasurements", () => {
    const stabilize = createReviewVerticalStopStabilizer();
    const cursor: LineCursor = {
      fileId: "alpha",
      hunkIndex: 0,
      stableKey: "line:0:new:1",
      target: { side: "new", line: 1 },
    };
    const first = [{ kind: "line" as const, cursor }];
    const second = [{ kind: "line" as const, cursor: { ...cursor } }];

    expect(stabilize(first)).toBe(first);
    expect(stabilize(second)).toBe(first);
  });
});
