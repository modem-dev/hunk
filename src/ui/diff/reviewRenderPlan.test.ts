import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../../core/types";
import type { PlannedReviewRow } from "./reviewRenderPlan";
import { resolveTheme } from "../themes";

const { buildSplitRows, buildStackRows } = await import("./pierre");
const { buildReviewRenderPlan } = await import("./reviewRenderPlan");

function lines(...values: string[]) {
  return `${values.join("\n")}\n`;
}

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
  return noteIndex >= 0 ? plannedRows[noteIndex + 1] : undefined;
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
  test("inserts an inline note before the anchor row and continues the guide through the covered range", () => {
    const theme = resolveTheme("midnight", null);
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
        {
          id: "annotation:alpha:0:0",
          annotation: {
            newRange: [2, 3],
            summary: "Explain the expanded new-side range",
            rationale: "The annotation should anchor to the first matching new-side row.",
          },
        },
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

    expect(guidedSplitLineNumbers(plannedRows, "new")).toEqual([2, 3]);

    const cap = plannedRows.find((row) => row.kind === "note-guide-cap");
    expect(cap?.kind).toBe("note-guide-cap");
    if (cap?.kind === "note-guide-cap") {
      expect(cap.side).toBe("new");
    }
  });

  test("anchors deletion-only notes to old-side rows and guides the old column", () => {
    const theme = resolveTheme("midnight", null);
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
        {
          id: "annotation:deleted:0:0",
          annotation: {
            oldRange: [1, 1],
            summary: "Explain the removed line",
            rationale: "Deletion notes should visually anchor on the old side.",
          },
        },
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

    expect(guidedSplitLineNumbers(plannedRows, "old")).toEqual([1]);

    const cap = plannedRows.find((row) => row.kind === "note-guide-cap");
    expect(cap?.kind).toBe("note-guide-cap");
    if (cap?.kind === "note-guide-cap") {
      expect(cap.side).toBe("old");
    }
  });

  test("assigns hunk anchor ids from the first visible row for every hunk when hunk headers are hidden", () => {
    const theme = resolveTheme("midnight", null);
    const file = createDiffFile(
      "beta",
      "beta.ts",
      lines(
        "export const line1 = 1;",
        "export const line2 = 2;",
        "export const line3 = 3;",
        "export const line4 = 4;",
        "export const line5 = 5;",
        "export const line6 = 6;",
        "export const line7 = 7;",
        "export const line8 = 8;",
        "export const line9 = 9;",
        "export const line10 = 10;",
        "export const line11 = 11;",
        "export const line12 = 12;",
      ),
      lines(
        "export const line1 = 1;",
        "export const line2 = 200;",
        "export const line3 = 3;",
        "export const line4 = 4;",
        "export const line5 = 5;",
        "export const line6 = 6;",
        "export const line7 = 7;",
        "export const line8 = 8;",
        "export const line9 = 9;",
        "export const line10 = 10;",
        "export const line11 = 1100;",
        "export const line12 = 12;",
      ),
    );
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

  test("anchors range-less notes to the first visible line row without guide rows", () => {
    const theme = resolveTheme("midnight", null);
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
        {
          id: "annotation:stack:0:0",
          annotation: {
            summary: "General hunk note",
            rationale: "No explicit line range is attached yet.",
          },
        },
      ],
    });

    const note = firstInlineNote(plannedRows);
    expect(note?.kind).toBe("inline-note");
    if (note?.kind === "inline-note") {
      expect(note.anchorSide).toBeUndefined();
    }

    expect(plannedRows.some((row) => row.kind === "note-guide-cap")).toBe(false);
    expect(
      plannedRows.some((row) => row.kind === "diff-row" && row.noteGuideSide !== undefined),
    ).toBe(false);

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.row.type).toBe("stack-line");
    }
  });

  test("anchors notes on the matching hunk in multi-hunk diffs", () => {
    const theme = resolveTheme("midnight", null);
    const file = createDiffFile(
      "multi",
      "multi.ts",
      lines(
        "export const line1 = 1;",
        "export const line2 = 2;",
        "export const line3 = 3;",
        "export const line4 = 4;",
        "export const line5 = 5;",
        "export const line6 = 6;",
        "export const line7 = 7;",
        "export const line8 = 8;",
        "export const line9 = 9;",
        "export const line10 = 10;",
        "export const line11 = 11;",
        "export const line12 = 12;",
      ),
      lines(
        "export const line1 = 1;",
        "export const line2 = 200;",
        "export const line3 = 3;",
        "export const line4 = 4;",
        "export const line5 = 5;",
        "export const line6 = 6;",
        "export const line7 = 7;",
        "export const line8 = 8;",
        "export const line9 = 9;",
        "export const line10 = 10;",
        "export const line11 = 1100;",
        "export const line12 = 12;",
      ),
    );
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 1,
      showHunkHeaders: true,
      visibleAgentNotes: [
        {
          id: "annotation:multi:1:0",
          annotation: {
            newRange: [11, 11],
            summary: "Explain the later change",
            rationale: "The note should attach to the second hunk only.",
          },
        },
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

  test("renders every visible note at its own anchor row", () => {
    const theme = resolveTheme("midnight", null);
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
        {
          id: "annotation:counted:0:0",
          annotation: {
            newRange: [2, 2],
            summary: "First visible note",
          },
        },
        {
          id: "annotation:counted:0:1",
          annotation: {
            newRange: [1, 1],
            summary: "Second visible note",
          },
        },
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
