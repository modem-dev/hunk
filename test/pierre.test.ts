import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../src/core/types";
import {
  buildSplitRows,
  buildStackRows,
  loadHighlightedDiff,
  type DiffRow,
} from "../src/ui/diff/pierre";
import { resolveTheme } from "../src/ui/themes";

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

    expect(changedRow.left.spans.some((span) => span.text.includes("41"))).toBe(true);
    expect(changedRow.right.spans.some((span) => span.text.includes("42"))).toBe(true);
    expect(changedRow.left.spans.some((span) => span.bg === theme.removedContentBg)).toBe(true);
    expect(changedRow.right.spans.some((span) => span.bg === theme.addedContentBg)).toBe(true);
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

  test("remaps Pierre markdown reds and greens away from diff-semantic hues", async () => {
    const file = createMarkdownDiffFile();

    for (const themeId of ["midnight", "paper"] as const) {
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
});
