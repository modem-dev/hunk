import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../../core/types";
import {
  buildSplitRows,
  buildStackRows,
  loadHighlightedDiff,
  loadHighlightedSourceLines,
  spansForHighlightedSourceLine,
  type DiffRow,
} from "./pierre";
import { renderCodeOnlyPlannedRowText, renderDecoratedPlannedRowText } from "./renderRows";
import { buildReviewRenderPlan } from "./reviewRenderPlan";
import { resolveTheme } from "../themes";

function createDiffFile(): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: "example.ts",
      contents: "export const answer = 41;\nexport const stable = true;\n",
      cacheKey: "before",
    },
    {
      name: "example.ts",
      contents:
        "export const answer = 42;\nexport const stable = true;\nexport const added = true;\n",
      cacheKey: "after",
    },
    { context: 3 },
    true,
  );

  return {
    id: "example",
    path: "example.ts",
    patch: "",
    language: "typescript",
    stats: {
      additions: 2,
      deletions: 1,
    },
    metadata,
    agent: null,
  };
}

function createEmptyLineDiffFile(): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: "empty.ts",
      contents: "function foo() {\n  return 1;\n}\n",
      cacheKey: "before-empty",
    },
    {
      name: "empty.ts",
      contents: "function foo() {\n\n  return 2;\n}\n",
      cacheKey: "after-empty",
    },
    { context: 3 },
    true,
  );

  return {
    id: "empty",
    path: "empty.ts",
    patch: "",
    language: "typescript",
    stats: {
      additions: 2,
      deletions: 1,
    },
    metadata,
    agent: null,
  };
}

function createMarkdownDiffFile(): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: "notes.md",
      contents: "plain\n",
      cacheKey: "before-md",
    },
    {
      name: "notes.md",
      contents: "# Heading\n`inline code`\nplain\n",
      cacheKey: "after-md",
    },
    { context: 3 },
    true,
  );

  return {
    id: "notes-md",
    path: "notes.md",
    patch: "",
    language: "markdown",
    stats: {
      additions: 2,
      deletions: 0,
    },
    metadata,
    agent: null,
  };
}

describe("Pierre diff rows", () => {
  test("builds split rows with Pierre-highlighted emphasis spans", async () => {
    const file = createDiffFile();
    const theme = resolveTheme("midnight", null);
    const highlighted = await loadHighlightedDiff(file);
    const rows = buildSplitRows(file, highlighted, theme);

    expect(rows.some((row) => row.type === "hunk-header")).toBe(true);

    const changedRow = rows.find(
      (row) =>
        row.type === "split-line" && row.left.kind === "deletion" && row.right.kind === "addition",
    );

    expect(changedRow).toBeDefined();

    if (!changedRow || changedRow.type !== "split-line") {
      throw new Error("Expected a split-line change row");
    }

    const removedWordSpan = changedRow.left.spans.find((span) => span.text.includes("41"));
    const addedWordSpan = changedRow.right.spans.find((span) => span.text.includes("42"));

    expect(removedWordSpan).toBeDefined();
    expect(addedWordSpan).toBeDefined();
    expect(removedWordSpan?.bg).toBeDefined();
    expect(addedWordSpan?.bg).toBeDefined();
    expect(changedRow.left.spans.some((span) => span.text.includes("export") && span.bg)).toBe(
      false,
    );
    expect(changedRow.right.spans.some((span) => span.text.includes("export") && span.bg)).toBe(
      false,
    );
    expect(
      changedRow.right.spans.some(
        (span) => span.text.includes("export") && typeof span.fg === "string",
      ),
    ).toBe(true);
  });

  test("builds stacked rows with separate deletion and addition lines", () => {
    const file = createDiffFile();
    const theme = resolveTheme("paper", null);
    const rows = buildStackRows(file, null, theme);

    const deletionRow = rows.find(
      (row) => row.type === "stack-line" && row.cell.kind === "deletion",
    );
    const additionRow = rows.find(
      (row) => row.type === "stack-line" && row.cell.kind === "addition",
    );

    expect(deletionRow).toBeDefined();
    expect(additionRow).toBeDefined();

    if (!deletionRow || deletionRow.type !== "stack-line") {
      throw new Error("Expected a stacked deletion row");
    }

    if (!additionRow || additionRow.type !== "stack-line") {
      throw new Error("Expected a stacked addition row");
    }

    expect(deletionRow.cell.oldLineNumber).toBe(1);
    expect(deletionRow.cell.newLineNumber).toBeUndefined();
    expect(additionRow.cell.oldLineNumber).toBeUndefined();
    expect(additionRow.cell.newLineNumber).toBe(1);
  });

  test("renders planned split rows to copyable visible text", () => {
    const file = createDiffFile();
    const theme = resolveTheme("midnight", null);
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders: true,
    });
    const changedRow = plannedRows.find(
      (row) => row.kind === "diff-row" && row.row.type === "split-line",
    );

    expect(changedRow).toBeDefined();
    if (!changedRow || changedRow.kind !== "diff-row") {
      throw new Error("Expected a planned split diff row");
    }

    const [line] = renderDecoratedPlannedRowText(changedRow, {
      codeHorizontalOffset: 0,
      lineNumberDigits: 1,
      showHunkHeaders: true,
      showLineNumbers: true,
      theme,
      width: 80,
      wrapLines: false,
    });

    expect(line).toContain("- export const answer = 41;");
    expect(line).toContain("+ export const answer = 42;");
  });

  test("renders planned stack rows with horizontal copy offset", () => {
    const file = createDiffFile();
    const theme = resolveTheme("midnight", null);
    const rows = buildStackRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders: true,
    });
    const additionRow = plannedRows.find(
      (row) =>
        row.kind === "diff-row" &&
        row.row.type === "stack-line" &&
        row.row.cell.kind === "addition",
    );

    expect(additionRow).toBeDefined();
    if (!additionRow || additionRow.kind !== "diff-row") {
      throw new Error("Expected a planned stack addition row");
    }

    const [line] = renderDecoratedPlannedRowText(additionRow, {
      codeHorizontalOffset: 7,
      lineNumberDigits: 1,
      showHunkHeaders: true,
      showLineNumbers: true,
      theme,
      width: 40,
      wrapLines: false,
    });

    expect(line).toContain("nst answer = 42;");
    expect(line).not.toContain("export const");
  });

  test("renders planned rows as code-only copy text when decorations are disabled", () => {
    const file = createDiffFile();
    const theme = resolveTheme("midnight", null);
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders: true,
    });
    const headerRow = plannedRows.find(
      (row) => row.kind === "diff-row" && row.row.type === "hunk-header",
    );
    const changedRow = plannedRows.find(
      (row) => row.kind === "diff-row" && row.row.type === "split-line",
    );

    expect(headerRow).toBeDefined();
    expect(changedRow).toBeDefined();
    if (!headerRow || !changedRow) {
      throw new Error("Expected planned header and split rows");
    }

    expect(
      renderCodeOnlyPlannedRowText(headerRow, {
        codeHorizontalOffset: 0,
        lineNumberDigits: 1,
        showHunkHeaders: true,
        showLineNumbers: true,
        theme,
        width: 80,
        wrapLines: false,
      }),
    ).toEqual([]);
    expect(
      renderCodeOnlyPlannedRowText(changedRow, {
        codeHorizontalOffset: 0,
        lineNumberDigits: 1,
        showHunkHeaders: true,
        showLineNumbers: true,
        theme,
        width: 80,
        wrapLines: false,
      }),
    ).toEqual(["export const answer = 41;", "export const answer = 42;"]);
  });

  test("does not produce newline characters in spans for highlighted empty lines", async () => {
    const file = createEmptyLineDiffFile();
    const theme = resolveTheme("midnight", null);
    const highlighted = await loadHighlightedDiff(file);

    for (const buildRows of [buildSplitRows, buildStackRows]) {
      const rows = buildRows(file, highlighted, theme);
      const allSpans = rows.flatMap((row) => {
        if (row.type === "split-line") return [...row.left.spans, ...row.right.spans];
        if (row.type === "stack-line") return row.cell.spans;
        return [];
      });

      expect(allSpans.every((span) => !span.text.includes("\n"))).toBe(true);
    }
  });

  test("builds syntax spans for highlighted full-source lines", async () => {
    const file = createDiffFile();
    const theme = resolveTheme("midnight", null);
    const text = "export const hiddenMarker = true;\n";
    const highlighted = await loadHighlightedSourceLines({
      file,
      text,
      appearance: theme.appearance,
    });
    const spans = spansForHighlightedSourceLine(
      "export const hiddenMarker = true;",
      highlighted.lines[0],
      theme,
    );

    expect(spans.map((span) => span.text).join("")).toBe("export const hiddenMarker = true;");
    expect(spans.some((span) => span.text.includes("export") && typeof span.fg === "string")).toBe(
      true,
    );
  });

  test("remaps Pierre markdown reds and greens away from diff-semantic hues", async () => {
    const file = createMarkdownDiffFile();

    for (const themeId of ["midnight", "paper", "catppuccin-latte", "catppuccin-mocha"] as const) {
      const theme = resolveTheme(themeId, null);
      const highlighted = await loadHighlightedDiff(file, theme.appearance);
      const rows = buildStackRows(file, highlighted, theme).filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      );

      const headingRow = rows.find((row) =>
        row.cell.spans.some((span) => span.text.includes("Heading")),
      );
      const inlineCodeRow = rows.find((row) =>
        row.cell.spans.some((span) => span.text.includes("inline code")),
      );

      expect(headingRow).toBeDefined();
      expect(inlineCodeRow).toBeDefined();

      if (!headingRow || !inlineCodeRow) {
        throw new Error("Expected highlighted markdown rows");
      }

      expect(
        headingRow.cell.spans.some(
          (span) => span.text.includes("Heading") && span.fg === theme.syntaxColors.keyword,
        ),
      ).toBe(true);
      expect(
        inlineCodeRow.cell.spans.some(
          (span) => span.text.includes("inline code") && span.fg === theme.syntaxColors.string,
        ),
      ).toBe(true);
      expect(
        headingRow.cell.spans.some((span) => span.fg === "#ff6762" || span.fg === "#d52c36"),
      ).toBe(false);
      expect(
        inlineCodeRow.cell.spans.some((span) => span.fg === "#5ecc71" || span.fg === "#199f43"),
      ).toBe(false);
    }
  });

  test("collapsed rows carry line ranges and position on both layouts", () => {
    // Fixture: a 30-line file with a single change at line 5, context=3.
    // Pierre produces one hunk covering old/new lines 2..8 (1 change + 3 lines of
    // surrounding context). One leading gap (line 1) and one trailing gap
    // (lines 9..30) should appear as collapsed rows with explicit ranges.
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
    const after = before.replace("line 5\n", "line 5 modified\n");

    const metadata = parseDiffFromFile(
      { name: "f.txt", contents: before, cacheKey: "single-change-before" },
      { name: "f.txt", contents: after, cacheKey: "single-change-after" },
      { context: 3 },
      true,
    );

    const file: DiffFile = {
      id: "single-change",
      path: "f.txt",
      patch: "",
      stats: { additions: 1, deletions: 1 },
      metadata,
      agent: null,
    };

    const theme = resolveTheme("midnight", null);

    for (const buildRows of [buildSplitRows, buildStackRows]) {
      const rows = buildRows(file, null, theme);
      const collapsedRows = rows.filter(
        (row): row is Extract<DiffRow, { type: "collapsed" }> => row.type === "collapsed",
      );

      const leading = collapsedRows.find((row) => row.position === "before");
      const trailing = collapsedRows.find((row) => row.position === "trailing");

      expect(leading).toBeDefined();
      expect(trailing).toBeDefined();

      expect(leading?.oldRange).toEqual([1, 1]);
      expect(leading?.newRange).toEqual([1, 1]);
      expect(trailing?.oldRange?.[0]).toBe(9);
      expect(trailing?.newRange?.[0]).toBe(9);
    }
  });

  test("between-hunks collapsed row spans the unchanged region between two hunks", () => {
    // Fixture: changes at lines 5 and 25 with context=3 produce two hunks
    // separated by lines 9..21 of unchanged context.
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
    const after = before
      .replace("line 5\n", "line 5 changed\n")
      .replace("line 25\n", "line 25 changed\n");

    const metadata = parseDiffFromFile(
      { name: "f.txt", contents: before, cacheKey: "two-hunks-before" },
      { name: "f.txt", contents: after, cacheKey: "two-hunks-after" },
      { context: 3 },
      true,
    );

    const file: DiffFile = {
      id: "two-hunks",
      path: "f.txt",
      patch: "",
      stats: { additions: 2, deletions: 2 },
      metadata,
      agent: null,
    };

    const theme = resolveTheme("midnight", null);
    const rows = buildSplitRows(file, null, theme);
    const between = rows.find(
      (row): row is Extract<DiffRow, { type: "collapsed" }> =>
        row.type === "collapsed" && row.position === "before" && row.hunkIndex === 1,
    );

    expect(between).toBeDefined();
    expect(between?.oldRange).toEqual([9, 21]);
    expect(between?.newRange).toEqual([9, 21]);
  });

  test("keeps reserved-color remaps isolated across dark themes", async () => {
    const file = createMarkdownDiffFile();
    const highlighted = await loadHighlightedDiff(file, "dark");

    for (const themeId of ["graphite", "midnight", "ember", "catppuccin-mocha"] as const) {
      const theme = resolveTheme(themeId, null);
      const rows = buildStackRows(file, highlighted, theme).filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      );

      const headingRow = rows.find((row) =>
        row.cell.spans.some((span) => span.text.includes("Heading")),
      );
      const inlineCodeRow = rows.find((row) =>
        row.cell.spans.some((span) => span.text.includes("inline code")),
      );

      expect(headingRow).toBeDefined();
      expect(inlineCodeRow).toBeDefined();

      if (!headingRow || !inlineCodeRow) {
        throw new Error("Expected highlighted markdown rows");
      }

      expect(
        headingRow.cell.spans.some(
          (span) => span.text.includes("Heading") && span.fg === theme.syntaxColors.keyword,
        ),
      ).toBe(true);
      expect(
        inlineCodeRow.cell.spans.some(
          (span) => span.text.includes("inline code") && span.fg === theme.syntaxColors.string,
        ),
      ).toBe(true);
    }
  });
});
