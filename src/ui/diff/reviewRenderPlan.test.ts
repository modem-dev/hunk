import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import { hunkLineRange } from "../../core/liveComments";
import type { DiffFile } from "../../core/types";
import {
  contextLineStableKeyTarget,
  lineStableKey,
  lineStableKeyTarget,
  type PlannedReviewRow,
} from "./reviewRenderPlan";
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
      hunks: file.metadata.hunks,
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
      hunks: file.metadata.hunks,
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

    expect(guidedSplitLineNumbers(plannedRows, "old")).toEqual([]);
  });

  test("assigns hunk anchor ids from the first visible row for every hunk when hunk headers are hidden", () => {
    const theme = resolveTheme("github-dark-default", null);
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
      hunks: file.metadata.hunks,
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
      hunks: file.metadata.hunks,
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

    expect(
      plannedRows.some((row) => row.kind === "diff-row" && row.noteGuideSide !== undefined),
    ).toBe(false);

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.row.type).toBe("stack-line");
    }
  });

  test("uses the first-hunk fallback for ranged notes outside visible hunks", () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createDiffFile(
      "outside",
      "outside.ts",
      "export const value = 1;\n",
      "export const value = 2;\n",
    );
    const rows = buildStackRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      hunks: file.metadata.hunks,
      rows,
      selectedHunkIndex: 0,
      showHunkHeaders: true,
      visibleAgentNotes: [
        {
          id: "annotation:outside",
          annotation: { summary: "Outside", newRange: [500, 500] },
        },
      ],
    });

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.hunkIndex).toBe(0);
      expect(anchoredRow.row.type).toBe("stack-line");
    }
  });

  test("keeps a partially intersecting preferred range in its later owner hunk", () => {
    const theme = resolveTheme("github-dark-default", null);
    const beforeLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[1] = "line 2 changed";
    afterLines[10] = "line 11 changed";
    const file = createDiffFile(
      "partial-later",
      "partial-later.ts",
      lines(...beforeLines),
      lines(...afterLines),
    );
    expect(file.metadata.hunks).toHaveLength(2);

    const firstRange = hunkLineRange(file.metadata.hunks[0]!);
    const laterRange = hunkLineRange(file.metadata.hunks[1]!);
    const preferredStart = laterRange.newRange[0] - 1;
    expect(preferredStart).toBeGreaterThan(firstRange.newRange[1]);

    const rows = buildStackRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      hunks: file.metadata.hunks,
      rows,
      showHunkHeaders: true,
      visibleAgentNotes: [
        {
          id: "annotation:partial-later",
          annotation: {
            oldRange: [firstRange.oldRange[0], firstRange.oldRange[0]],
            newRange: [preferredStart, laterRange.newRange[0]],
            summary: "The preferred start is collapsed but the range reaches the later hunk",
          },
        },
      ],
    });

    const anchoredRow = inlineNoteAnchorRow(plannedRows);
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.hunkIndex).toBe(1);
      expect(anchoredRow.row.type).toBe("stack-line");
      if (anchoredRow.row.type === "stack-line") {
        expect(anchoredRow.row.cell.newLineNumber).toBe(laterRange.newRange[0]);
      }
    }
  });

  test("anchors notes on the matching hunk in multi-hunk diffs", () => {
    const theme = resolveTheme("github-dark-default", null);
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
      hunks: file.metadata.hunks,
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
      hunks: file.metadata.hunks,
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
