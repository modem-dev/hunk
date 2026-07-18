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
import { resolveSplitPaneWidths } from "./codeColumns";
import { renderCodeOnlyPlannedRowText, renderDecoratedPlannedRowText } from "./renderRows";
import { stackCellPalette } from "./rowStyle";
import { buildReviewRenderPlan } from "./reviewRenderPlan";
import { measureTextWidth } from "../lib/text";
import { TRANSPARENT_BACKGROUND, resolveTheme } from "../themes";

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

describe("Pierre diff rows", () => {
  test("builds split rows with Pierre-highlighted emphasis spans", async () => {
    const file = createDiffFile();
    const theme = resolveTheme("github-dark-default", null);
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

  test("keeps word-diff highlight backgrounds transparent when a theme uses transparent tints", async () => {
    const file = createDiffFile();
    // Custom themes may declare "transparent" row/content tints; the renderer must not feed
    // them into blend math and turn them into black backgrounds.
    const theme = {
      ...resolveTheme("github-dark-default", null),
      addedBg: TRANSPARENT_BACKGROUND,
      removedBg: TRANSPARENT_BACKGROUND,
      addedContentBg: TRANSPARENT_BACKGROUND,
      removedContentBg: TRANSPARENT_BACKGROUND,
    };
    const highlighted = await loadHighlightedDiff(file);
    const rows = buildSplitRows(file, highlighted, theme);
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

    expect(removedWordSpan?.bg).toBe(TRANSPARENT_BACKGROUND);
    expect(addedWordSpan?.bg).toBe(TRANSPARENT_BACKGROUND);
  });

  test("builds stacked rows with separate deletion and addition lines", () => {
    const file = createDiffFile();
    const theme = resolveTheme("github-light-default", null);
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

  test("carries moved-line tags into row palettes", () => {
    const file = createDiffFile();
    file.lineMoveKinds = {
      deletionLines: ["moved"],
      additionLines: ["moved"],
    };
    const theme = resolveTheme("github-dark-default", null);
    const rows = buildStackRows(file, null, theme);
    const movedDeletion = rows.find(
      (row) => row.type === "stack-line" && row.cell.kind === "deletion",
    );
    const movedAddition = rows.find(
      (row) => row.type === "stack-line" && row.cell.kind === "addition",
    );

    expect(movedDeletion).toBeDefined();
    expect(movedAddition).toBeDefined();

    if (!movedDeletion || movedDeletion.type !== "stack-line") {
      throw new Error("Expected a moved deletion row");
    }

    if (!movedAddition || movedAddition.type !== "stack-line") {
      throw new Error("Expected a moved addition row");
    }

    expect(movedDeletion.cell.moveKind).toBe("moved");
    expect(movedAddition.cell.moveKind).toBe("moved");
    expect(
      stackCellPalette(movedDeletion.cell.kind, theme, movedDeletion.cell.moveKind).contentBg,
    ).toBe(theme.movedRemovedBg);
    expect(
      stackCellPalette(movedAddition.cell.kind, theme, movedAddition.cell.moveKind).contentBg,
    ).toBe(theme.movedAddedBg);
  });

  test("renders planned split rows to copyable visible text", () => {
    const file = createDiffFile();
    const theme = resolveTheme("github-dark-default", null);
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

  test("keeps the split separator aligned after wide characters", () => {
    const metadata = parseDiffFromFile(
      {
        name: "i18n.ts",
        contents: "export const message = '日本語';\n",
        cacheKey: "before-wide",
      },
      {
        name: "i18n.ts",
        contents: "export const message = 'abc';\n",
        cacheKey: "after-wide",
      },
      { context: 3 },
      true,
    );
    const file: DiffFile = {
      id: "i18n",
      path: "i18n.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 1, deletions: 1 },
      metadata,
      agent: null,
    };
    const theme = resolveTheme("github-dark-default", null);
    const rows = buildSplitRows(file, null, theme);
    const plannedRows = buildReviewRenderPlan({ fileId: file.id, rows, showHunkHeaders: true });
    const changedRow = plannedRows.find(
      (row) =>
        row.kind === "diff-row" &&
        row.row.type === "split-line" &&
        row.row.left.kind === "deletion",
    );

    expect(changedRow).toBeDefined();
    if (!changedRow || changedRow.kind !== "diff-row") {
      throw new Error("Expected a planned split diff row");
    }

    const width = 80;
    const { leftWidth } = resolveSplitPaneWidths(width);
    const line = renderDecoratedPlannedRowText(changedRow, {
      codeHorizontalOffset: 0,
      lineNumberDigits: 1,
      showHunkHeaders: true,
      showLineNumbers: true,
      theme,
      width,
      wrapLines: false,
    })[0];
    expect(line).toBeDefined();
    if (!line) {
      throw new Error("Expected a rendered split row");
    }
    const centerSeparatorIndex = line.indexOf("▌", 1);

    expect(line).toContain("日本語");
    expect(measureTextWidth(line.slice(0, centerSeparatorIndex))).toBe(leftWidth);
  });

  test("renders planned stack rows with horizontal copy offset", () => {
    const file = createDiffFile();
    const theme = resolveTheme("github-dark-default", null);
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
    const theme = resolveTheme("github-dark-default", null);
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
    const theme = resolveTheme("github-dark-default", null);
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
    const theme = resolveTheme("github-dark-default", null);
    const text = "export const hiddenMarker = true;\n";
    const highlighted = await loadHighlightedSourceLines({
      file,
      text,
      theme,
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

  test("applies distinct custom palettes to expanded-source highlighting", async () => {
    const file = createDiffFile();
    const text = "// expanded comment\nexport const hiddenMarker = true;\n";
    const firstTheme = resolveTheme("custom", null, {
      base: "nord",
      syntaxScopes: {
        "comment.line.double-slash.ts": "#abcdef",
        "punctuation.definition.comment.ts": "#abcdef",
      },
    });
    const secondTheme = resolveTheme("custom", null, {
      base: "nord",
      syntaxScopes: {
        "comment.line.double-slash.ts": "#fedcba",
        "punctuation.definition.comment.ts": "#fedcba",
      },
    });
    const [firstHighlighted, secondHighlighted] = await Promise.all([
      loadHighlightedSourceLines({ file, text, theme: firstTheme }),
      loadHighlightedSourceLines({ file, text, theme: secondTheme }),
    ]);
    const firstSpans = spansForHighlightedSourceLine(
      "// expanded comment",
      firstHighlighted.lines[0],
      firstTheme,
    );
    const secondSpans = spansForHighlightedSourceLine(
      "// expanded comment",
      secondHighlighted.lines[0],
      secondTheme,
    );

    expect(firstSpans[0]?.fg?.toLowerCase()).toBe("#abcdef");
    expect(secondSpans[0]?.fg?.toLowerCase()).toBe("#fedcba");
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

    const theme = resolveTheme("github-dark-default", null);

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

    const theme = resolveTheme("github-dark-default", null);
    const rows = buildSplitRows(file, null, theme);
    const between = rows.find(
      (row): row is Extract<DiffRow, { type: "collapsed" }> =>
        row.type === "collapsed" && row.position === "before" && row.hunkIndex === 1,
    );

    expect(between).toBeDefined();
    expect(between?.oldRange).toEqual([9, 21]);
    expect(between?.newRange).toEqual([9, 21]);
  });

  test("passes exact Shiki scope colors through in dark and light", async () => {
    const metadata = parseDiffFromFile(
      { name: "syntax.ts", contents: "", cacheKey: "syntax-before" },
      {
        name: "syntax.ts",
        contents:
          '// visible comment\nexport class Greeter {\n  count = 42;\n  greet(user: User) {\n    const message = "hello" + user.name;\n    return message;\n  }\n}\n',
        cacheKey: "syntax-after",
      },
      { context: 3 },
      true,
    );
    const file: DiffFile = {
      id: "syntax",
      path: "syntax.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 8, deletions: 0 },
      metadata,
      agent: null,
    };

    for (const themeId of ["github-dark-default", "github-light-default"] as const) {
      const theme = resolveTheme("custom", null, {
        base: themeId,
        syntaxScopes: {
          "storage.type.class.ts": "#112233",
          "entity.name.function.ts": "#223344",
          "string.quoted.double.ts": "#334455",
          comment: "#445566",
          "constant.numeric.decimal.ts": "#556677",
          "variable.other.property.ts": "#667788",
          "entity.name.type.class.ts": "#778899",
          "variable.other.constant.ts": "#8899aa",
          "keyword.operator.assignment.ts": "#99aabb",
          "punctuation.terminator.statement.ts": "#aabbcc",
        },
      });
      const highlighted = await loadHighlightedDiff(file, theme);
      const spans = buildStackRows(file, highlighted, theme)
        .filter(
          (row): row is Extract<DiffRow, { type: "stack-line" }> =>
            row.type === "stack-line" && row.cell.kind === "addition",
        )
        .flatMap((row) => row.cell.spans);

      expect(spans.find((span) => span.text.includes("class"))?.fg).toBe("#112233");
      expect(spans.find((span) => span.text.includes("greet"))?.fg).toBe("#223344");
      expect(spans.find((span) => span.text.includes("hello"))?.fg).toBe("#334455");
      expect(spans.find((span) => span.text.includes("visible comment"))?.fg).toBe("#445566");
      expect(spans.find((span) => span.text.includes("42"))?.fg).toBe("#556677");
      expect(spans.find((span) => span.text.includes("name"))?.fg).toBe("#667788");
      expect(spans.find((span) => span.text.includes("Greeter"))?.fg).toBe("#778899");
      expect(spans.find((span) => span.text.includes("message"))?.fg?.toLowerCase()).toBe(
        "#8899aa",
      );
      expect(spans.find((span) => span.text.includes("="))?.fg?.toLowerCase()).toBe("#99aabb");
      expect(spans.find((span) => span.text === ";")?.fg?.toLowerCase()).toBe("#aabbcc");
    }
  });

  test("preserves base Shiki colors outside partial custom syntax overrides", async () => {
    const metadata = parseDiffFromFile(
      { name: "partial.ts", contents: "const stable = 1;\n", cacheKey: "partial-before" },
      {
        name: "partial.ts",
        contents:
          '// customized comment\nconst stable = 1;\nconst object = { property: "text" };\nobject.property;\n',
        cacheKey: "partial-after",
      },
      { context: 3 },
      true,
    );
    const file: DiffFile = {
      id: "partial-syntax",
      path: "partial.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 3, deletions: 0 },
      metadata,
      agent: null,
    };
    const baseTheme = resolveTheme("nord", null);
    const customTheme = resolveTheme("custom", null, {
      base: "nord",
      syntaxScopes: {
        "comment.line.double-slash.ts": "#abcdef",
        "punctuation.definition.comment.ts": "#abcdef",
      },
    });
    const nextCustomTheme = resolveTheme("custom", null, {
      base: "nord",
      syntaxScopes: {
        "comment.line.double-slash.ts": "#fedcba",
        "punctuation.definition.comment.ts": "#fedcba",
      },
    });
    const variableTheme = resolveTheme("custom", null, {
      base: "nord",
      syntaxScopes: { "variable.other.object.ts": "#030303" },
    });
    const [baseHighlighted, customHighlighted, nextCustomHighlighted, variableHighlighted] =
      await Promise.all([
        loadHighlightedDiff(file, baseTheme),
        loadHighlightedDiff(file, customTheme),
        loadHighlightedDiff(file, nextCustomTheme),
        loadHighlightedDiff(file, variableTheme),
      ]);
    const baseSpans = buildStackRows(file, baseHighlighted, baseTheme)
      .filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      )
      .flatMap((row) => row.cell.spans);
    const customSpans = buildStackRows(file, customHighlighted, customTheme)
      .filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      )
      .flatMap((row) => row.cell.spans);
    const nextCustomSpans = buildStackRows(file, nextCustomHighlighted, nextCustomTheme)
      .filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      )
      .flatMap((row) => row.cell.spans);
    const variableSpans = buildStackRows(file, variableHighlighted, variableTheme)
      .filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      )
      .flatMap((row) => row.cell.spans);

    expect(customSpans.find((span) => span.text.includes("const"))?.fg).toBe(
      baseSpans.find((span) => span.text.includes("const"))?.fg,
    );
    expect(
      customSpans.find((span) => span.text.includes("customized comment"))?.fg?.toLowerCase(),
    ).toBe("#abcdef");
    expect(
      nextCustomSpans.find((span) => span.text.includes("customized comment"))?.fg?.toLowerCase(),
    ).toBe("#fedcba");
    expect(
      variableSpans.some(
        (span) => span.text.includes("object") && span.fg?.toLowerCase() === "#030303",
      ),
    ).toBe(true);
    expect(variableSpans.filter((span) => span.text.includes("property")).at(-1)?.fg).toBe(
      baseSpans.filter((span) => span.text.includes("property")).at(-1)?.fg,
    );
  });

  test("leaves unrelated tokens unchanged when a raw operator scope is overridden", async () => {
    const metadata = parseDiffFromFile(
      { name: "operator.ts", contents: "", cacheKey: "operator-before" },
      {
        name: "operator.ts",
        contents: "class Example {}\nconst result = 1 + 2;\n",
        cacheKey: "operator-after",
      },
      { context: 3 },
      true,
    );
    const file: DiffFile = {
      id: "operator-scope",
      path: "operator.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 2, deletions: 0 },
      metadata,
      agent: null,
    };
    const baseTheme = resolveTheme("everforest-dark", null);
    const customTheme = resolveTheme("custom", null, {
      base: "everforest-dark",
      syntaxScopes: { "keyword.operator": "#123456" },
    });
    const [baseHighlighted, customHighlighted] = await Promise.all([
      loadHighlightedDiff(file, baseTheme),
      loadHighlightedDiff(file, customTheme),
    ]);
    const baseSpans = buildStackRows(file, baseHighlighted, baseTheme)
      .filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      )
      .flatMap((row) => row.cell.spans);
    const customSpans = buildStackRows(file, customHighlighted, customTheme)
      .filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      )
      .flatMap((row) => row.cell.spans);

    expect(customSpans.find((span) => span.text.includes("class"))?.fg).toBe(
      baseSpans.find((span) => span.text.includes("class"))?.fg,
    );
    expect(
      customSpans.some((span) => span.text.includes("=") && span.fg?.toLowerCase() === "#123456"),
    ).toBe(true);
  });

  test("uses Shiki's bundled Catppuccin theme for Catppuccin syntax", async () => {
    const metadata = parseDiffFromFile(
      { name: "syntax.ts", contents: "const a = 1;\n", cacheKey: "catppuccin-before" },
      {
        name: "syntax.ts",
        contents:
          'const a = 1;\nexport class Greeter {\n  count = 42;\n  greet(user: User) {\n    return "hello" + user.name;\n  }\n}\n',
        cacheKey: "catppuccin-after",
      },
      { context: 3 },
      true,
    );
    const file: DiffFile = {
      id: "catppuccin-syntax",
      path: "syntax.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 6, deletions: 0 },
      metadata,
      agent: null,
    };
    const theme = resolveTheme("catppuccin-mocha", null);
    const highlighted = await loadHighlightedDiff(file, theme);
    const spans = buildStackRows(file, highlighted, theme)
      .filter(
        (row): row is Extract<DiffRow, { type: "stack-line" }> =>
          row.type === "stack-line" && row.cell.kind === "addition",
      )
      .flatMap((row) => row.cell.spans);

    expect(theme.syntaxTheme).toBe("catppuccin-mocha");
    expect(spans.find((span) => span.text.includes("class"))?.fg?.toLowerCase()).toBe("#cba6f7");
    expect(spans.find((span) => span.text.includes("Greeter"))?.fg?.toLowerCase()).toBe("#f9e2af");
    expect(spans.find((span) => span.text.includes("=") && span.fg)?.fg?.toLowerCase()).toBe(
      "#94e2d5",
    );
    expect(spans.find((span) => span.text.includes("user") && span.fg)?.fg?.toLowerCase()).toBe(
      "#eba0ac",
    );
  });
});
