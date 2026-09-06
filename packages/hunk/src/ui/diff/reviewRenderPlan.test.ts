import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../../core/changeset/model";
import { createVisibleAgentNote } from "../lib/agentAnnotations";
import { expandCollapsedRows } from "./expandCollapsedRows";
import {
  contextLineStableKeyTarget,
  lineStableKey,
  lineStableKeyTarget,
  type PlannedReviewRow,
} from "./reviewRenderPlan";
import { resolveTheme } from "../themes";

const { buildSplitRows, buildStackRows } = await import("./diffRows");
const { buildReviewRenderPlan } = await import("./reviewRenderPlan");

function lines(...values: string[]) {
  return `${values.join("\n")}\n`;
}

/** Twelve lines changed at line 2 and line 11: two hunks with a collapsed gap between them. */
const TWELVE_LINES_BEFORE = lines(
  ...Array.from({ length: 12 }, (_, index) => `export const line${index + 1} = ${index + 1};`),
);
const TWELVE_LINES_AFTER = TWELVE_LINES_BEFORE.replace(
  "export const line2 = 2;",
  "export const line2 = 200;",
).replace("export const line11 = 11;", "export const line11 = 1100;");

function createDiffFile(id: string, path: string, before: string, after: string): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `${id}:before`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `${id}:after`,
    },
    { context: 3 },
    true,
  );

  let additions = 0;
  let deletions = 0;
  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }

  return {
    id,
    path,
    patch: "",
    language: "typescript",
    stats: { additions, deletions },
    metadata,
    agent: null,
  };
}

function firstInlineNote(plannedRows: PlannedReviewRow[]) {
  return plannedRows.find((row) => row.kind === "inline-note");
}

function inlineNoteAnchorRow(plannedRows: PlannedReviewRow[]) {
  const noteIndex = plannedRows.findIndex((row) => row.kind === "inline-note");
  return noteIndex > 0 ? plannedRows[noteIndex - 1] : undefined;
}

function guidedSplitLineNumbers(plannedRows: PlannedReviewRow[], side: "old" | "new") {
  return plannedRows.flatMap((row) => {
    if (row.kind !== "diff-row" || row.noteGuideSide !== side || row.row.type !== "split-line") {
      return [];
    }

    return [side === "new" ? row.row.right.lineNumber : row.row.left.lineNumber];
  });
}

describe("review render plan", () => {
  test("inserts an inline note after the anchor row and starts the guide below the note", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile(
      "alpha",
      "alpha.ts",
      "export const alpha = 1;\n",
      "export const alpha = 2;\nexport const beta = 3;\nexport const gamma = 4;\n",
    );
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 0,
      showHunkHeaders: true,
      visibleAgentNotes: [
        createVisibleAgentNote(file.metadata.hunks, {
          id: "annotation:alpha:0:0",
          annotation: {
            newRange: [2, 3],
            summary: "Explain the expanded new-side range",
            rationale: "The annotation should anchor to the first matching new-side row.",
          },
        }),
      ],
    });

    const note = firstInlineNote(plannedRows);
    expect(note?.kind).toBe("inline-note");
    if (note?.kind === "inline-note") {
      expect(note.anchorSide).toBe("new");
      expect(note.noteCount).toBe(1);
      expect(note.noteIndex).toBe(0);
    }

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.row.type).toBe("split-line");
      if (anchoredRow.row.type === "split-line") {
        expect(anchoredRow.row.right.lineNumber).toBe(2);
      }
    }

    expect(guidedSplitLineNumbers(plannedRows, "new")).toEqual([3]);
  });

  test("anchors deletion-only notes to old-side rows without a dangling guide above the note", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile(
      "deleted",
      "deleted.ts",
      lines("export const removed = true;", "export const kept = 1;"),
      lines("export const kept = 1;"),
    );
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 0,
      showHunkHeaders: true,
      visibleAgentNotes: [
        createVisibleAgentNote(file.metadata.hunks, {
          id: "annotation:deleted:0:0",
          annotation: {
            oldRange: [1, 1],
            summary: "Explain the removed line",
            rationale: "Deletion notes should visually anchor on the old side.",
          },
        }),
      ],
    });

    const note = firstInlineNote(plannedRows);
    expect(note?.kind).toBe("inline-note");
    if (note?.kind === "inline-note") {
      expect(note.anchorSide).toBe("old");
    }

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.row.type).toBe("split-line");
      if (anchoredRow.row.type === "split-line") {
        expect(anchoredRow.row.left.lineNumber).toBe(1);
        expect(anchoredRow.row.right.lineNumber).toBeUndefined();
      }
    }

    expect(guidedSplitLineNumbers(plannedRows, "old")).toEqual([]);
  });

  test("assigns hunk anchor ids from the first visible row for every hunk when hunk headers are hidden", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile("beta", "beta.ts", TWELVE_LINES_BEFORE, TWELVE_LINES_AFTER);
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 0,
      showHunkHeaders: false,
      visibleAgentNotes: [],
    });

    const anchorRows = plannedRows.filter(
      (row): row is Extract<PlannedReviewRow, { kind: "diff-row" }> =>
        row.kind === "diff-row" && row.anchorId !== undefined,
    );

    expect(anchorRows).toHaveLength(2);
    expect(anchorRows.map((row) => row.anchorId)).toEqual([
      `diff-hunk:${file.id}:0`,
      `diff-hunk:${file.id}:1`,
    ]);
    expect(anchorRows.every((row) => row.row.type === "split-line")).toBe(true);
  });

  test("anchors range-less notes to the shared default line without guide rows", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile(
      "stack",
      "stack.ts",
      "export const value = 1;\n",
      "export const value = 2;\nexport const added = true;\n",
    );
    const rows = buildStackRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 0,
      showHunkHeaders: true,
      visibleAgentNotes: [
        createVisibleAgentNote(file.metadata.hunks, {
          id: "annotation:stack:0:0",
          annotation: {
            summary: "General hunk note",
            rationale: "No explicit line range is attached yet.",
          },
        }),
      ],
    });

    const note = firstInlineNote(plannedRows);
    expect(note?.kind).toBe("inline-note");
    if (note?.kind === "inline-note") {
      expect(note.anchorSide).toBeUndefined();
    }

    expect(
      plannedRows.some((row) => row.kind === "diff-row" && row.noteGuideSide !== undefined),
    ).toBe(false);

    // A note with no range of its own hangs from the shared default: the new side's first line.
    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.row.type).toBe("stack-line");
      if (anchoredRow.row.type === "stack-line") {
        expect(anchoredRow.row.cell.newLineNumber).toBe(1);
      }
    }
  });

  test("anchors notes on the matching hunk in multi-hunk diffs", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile("multi", "multi.ts", TWELVE_LINES_BEFORE, TWELVE_LINES_AFTER);
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 1,
      showHunkHeaders: true,
      visibleAgentNotes: [
        createVisibleAgentNote(file.metadata.hunks, {
          id: "annotation:multi:1:0",
          annotation: {
            newRange: [11, 11],
            summary: "Explain the later change",
            rationale: "The note should attach to the second hunk only.",
          },
        }),
      ],
    });

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.hunkIndex).toBe(1);
      expect(anchoredRow.row.type).toBe("split-line");
      if (anchoredRow.row.type === "split-line") {
        expect(anchoredRow.row.right.lineNumber).toBe(11);
      }
    }
  });

  test("keeps a note on collapsed lines inside its owning hunk", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile(
      "collapsed",
      "collapsed.ts",
      TWELVE_LINES_BEFORE,
      TWELVE_LINES_AFTER,
    );
    const rows = buildSplitRows(file, null, theme);
    // Lines 6-7 sit in the gap between the two hunks, so no rendered row covers them.
    const note = createVisibleAgentNote(file.metadata.hunks, {
      id: "annotation:collapsed:0",
      annotation: {
        newRange: [6, 7],
        summary: "Explain the collapsed region",
        rationale: "The patch shows neither of these lines.",
      },
    });
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 0,
      showHunkHeaders: true,
      visibleAgentNotes: [note],
    });

    expect(note.anchor.intersectingHunkIndices).toEqual([]);
    expect(note.anchor.ownerHunkIndex).toBe(1);

    const inlineNote = firstInlineNote(plannedRows);
    expect(inlineNote?.kind).toBe("inline-note");
    if (inlineNote?.kind === "inline-note") {
      expect(inlineNote.hunkIndex).toBe(1);
    }

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.hunkIndex).toBe(1);
      expect(anchoredRow.row.type).toBe("split-line");
      if (anchoredRow.row.type === "split-line") {
        expect(anchoredRow.row.right.lineNumber).toBe(8);
      }
    }
  });

  test("places a note on an expanded gap line beside that line", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile("expanded", "expanded.ts", TWELVE_LINES_BEFORE, TWELVE_LINES_AFTER);
    const rows = expandCollapsedRows(buildSplitRows(file, null, theme), {
      layout: "split",
      expandedKeys: new Set(["before:1"]),
      sourceStatus: { kind: "loaded", text: TWELVE_LINES_AFTER },
    });
    const note = createVisibleAgentNote(file.metadata.hunks, {
      id: "annotation:expanded:0",
      annotation: { newRange: [7, 7], summary: "Explain the revealed line" },
    });
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 1,
      showHunkHeaders: true,
      visibleAgentNotes: [note],
    });

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.row.type).toBe("split-line");
      if (anchoredRow.row.type === "split-line") {
        expect(anchoredRow.row.isExpansionRow).toBe(true);
        expect(anchoredRow.row.right.lineNumber).toBe(7);
      }
    }
  });

  test("renders every visible note at its own anchor row", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile(
      "counted",
      "counted.ts",
      "export const value = 1;\n",
      "export const value = 2;\nexport const added = true;\n",
    );
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 0,
      showHunkHeaders: true,
      visibleAgentNotes: [
        createVisibleAgentNote(file.metadata.hunks, {
          id: "annotation:counted:0:0",
          annotation: {
            newRange: [2, 2],
            summary: "First visible note",
          },
        }),
        createVisibleAgentNote(file.metadata.hunks, {
          id: "annotation:counted:0:1",
          annotation: {
            newRange: [1, 1],
            summary: "Second visible note",
          },
        }),
      ],
    });

    const inlineNotes = plannedRows.filter(
      (row): row is Extract<PlannedReviewRow, { kind: "inline-note" }> =>
        row.kind === "inline-note",
    );

    expect(inlineNotes).toHaveLength(2);
    expect(inlineNotes.map((row) => row.annotationId)).toEqual([
      "annotation:counted:0:1",
      "annotation:counted:0:0",
    ]);
    expect(inlineNotes.every((row) => row.noteIndex === 0 && row.noteCount === 1)).toBe(true);
  });
});

describe("hunk-gap rows", () => {
  test("inserts a spacer before each hunk after the first in split and stack plans", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile("multi", "multi.ts", TWELVE_LINES_BEFORE, TWELVE_LINES_AFTER);

    for (const rows of [buildSplitRows(file, null, theme), buildStackRows(file, null, theme)]) {
      expect(
        buildReviewRenderPlan({ fileId: file.id, rows, showHunkHeaders: true }).some(
          (row) => row.kind === "hunk-gap",
        ),
      ).toBe(false);

      const plannedRows = buildReviewRenderPlan({
        fileId: file.id,
        rows,
        showHunkHeaders: true,
        hunkGap: 2,
      });
      const headerIndex = plannedRows.findIndex(
        (row) => row.kind === "diff-row" && row.row.type === "hunk-header" && row.hunkIndex === 1,
      );
      const gap = plannedRows[headerIndex - 1];

      expect(headerIndex).toBeGreaterThan(0);
      expect(gap?.kind).toBe("hunk-gap");
      if (gap?.kind === "hunk-gap") {
        expect(gap.height).toBe(2);
        expect(gap.hunkIndex).toBe(1);
      }
      expect(plannedRows.filter((row) => row.kind === "hunk-gap")).toHaveLength(1);
    }
  });

  test("keeps the spacer before a later hunk when hunk headers are hidden", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile("multi", "multi.ts", TWELVE_LINES_BEFORE, TWELVE_LINES_AFTER);
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders: false,
      hunkGap: 2,
    });
    const headerIndex = plannedRows.findIndex(
      (row) => row.kind === "diff-row" && row.row.type === "hunk-header" && row.hunkIndex === 1,
    );
    const gap = plannedRows[headerIndex - 1];

    expect(headerIndex).toBeGreaterThan(0);
    expect(gap?.kind).toBe("hunk-gap");
    if (gap?.kind === "hunk-gap") {
      expect(gap.height).toBe(2);
    }
  });
});

describe("line stable key targets", () => {
  test("reads a single-sided anchor back into a note target", () => {
    expect(lineStableKeyTarget(lineStableKey(2, "old", 41))).toEqual({
      hunkIndex: 2,
      side: "old",
      line: 41,
    });
    expect(lineStableKeyTarget(lineStableKey(0, "new", 7))).toEqual({
      hunkIndex: 0,
      side: "new",
      line: 7,
    });
  });

  test("reads a shared context anchor as its new-side line", () => {
    expect(contextLineStableKeyTarget("line:3:context:12:14")).toEqual({
      hunkIndex: 3,
      side: "new",
      line: 14,
    });
  });

  test("keeps the two anchor shapes apart", () => {
    expect(lineStableKeyTarget("line:3:context:12:14")).toBeNull();
    expect(contextLineStableKeyTarget(lineStableKey(3, "new", 14))).toBeNull();
  });

  test("ignores anchors that do not name a source line", () => {
    for (const stableKey of ["meta:hunk-header:1", "meta:collapsed:before:0", "inline-note:x"]) {
      expect(lineStableKeyTarget(stableKey)).toBeNull();
      expect(contextLineStableKeyTarget(stableKey)).toBeNull();
    }
  });
});
