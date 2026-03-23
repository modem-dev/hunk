import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../src/core/types";
import { resolveTheme } from "../src/ui/themes";

const { buildSplitRows, buildStackRows } = await import("../src/ui/diff/pierre");
const { buildReviewRenderPlan } = await import("../src/ui/diff/reviewRenderPlan");

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

    const noteIndex = plannedRows.findIndex((row) => row.kind === "inline-note");
    expect(noteIndex).toBeGreaterThan(0);

    const anchoredRow = plannedRows[noteIndex + 1];
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.row.type).toBe("split-line");
      if (anchoredRow.row.type === "split-line") {
        expect(anchoredRow.row.right.lineNumber).toBe(2);
      }
    }

    const guidedRows = plannedRows.filter(
      (row) => row.kind === "diff-row" && row.noteGuideSide === "new",
    );
    expect(guidedRows).toHaveLength(2);
    expect(
      guidedRows.map((row) =>
        row.kind === "diff-row" && row.row.type === "split-line" ? row.row.right.lineNumber : null,
      ),
    ).toEqual([2, 3]);

    const capIndex = plannedRows.findIndex((row) => row.kind === "note-guide-cap");
    expect(capIndex).toBeGreaterThan(noteIndex);
    expect(plannedRows[capIndex - 1]?.kind).toBe("diff-row");
  });

  test("assigns hunk anchor ids from the first visible row when hunk headers are hidden", () => {
    const theme = resolveTheme("midnight", null);
    const file = createDiffFile(
      "beta",
      "beta.ts",
      "export const beta = 1;\n",
      "export const beta = 2;\nexport const gamma = true;\n",
    );
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      selectedHunkIndex: 0,
      showHunkHeaders: false,
      visibleAgentNotes: [],
    });

    const anchorRow = plannedRows.find((row) => row.kind === "diff-row" && row.anchorId);
    expect(anchorRow?.kind).toBe("diff-row");
    if (anchorRow?.kind === "diff-row") {
      expect(anchorRow.row.type).toBe("split-line");
      expect(anchorRow.anchorId).toBe(`diff-hunk:${file.id}:0`);
    }
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

    const noteIndex = plannedRows.findIndex((row) => row.kind === "inline-note");
    expect(noteIndex).toBe(1);
    expect(plannedRows.some((row) => row.kind === "note-guide-cap")).toBe(false);
    expect(
      plannedRows.some((row) => row.kind === "diff-row" && row.noteGuideSide !== undefined),
    ).toBe(false);

    const anchoredRow = plannedRows[noteIndex + 1];
    expect(anchoredRow?.kind).toBe("diff-row");
    if (anchoredRow?.kind === "diff-row") {
      expect(anchoredRow.row.type).toBe("stack-line");
    }
  });
});
