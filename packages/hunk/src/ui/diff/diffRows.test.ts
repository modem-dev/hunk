import { describe, expect, test } from "bun:test";
import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import type { DiffFile } from "../../core/changeset/model";
import {
  buildSplitRows,
  buildStackRows,
  HIGHLIGHT_WORKER_MIN_LINES,
  highlightedDiffLineCount,
  loadHighlightedDiff,
  shouldOffloadHighlight,
  loadHighlightedSourceLines,
  shouldHighlightDiff,
  spansForHighlightedSourceLine,
  type DiffRow,
} from "./diffRows";
import { resolveSplitPaneWidths } from "./codeColumns";
import { renderCodeOnlyPlannedRowText, renderDecoratedPlannedRowText } from "./plannedRowText";
import { stackCellPalette } from "./rowStyle";
import { buildReviewRenderPlan } from "./reviewRenderPlan";
import { measureTextWidth } from "../lib/text";
import { TRANSPARENT_BACKGROUND, resolveTheme } from "../themes";
import { createTestSourceFetcher } from "../../../../../test/helpers/diff-helpers";
import { createTestCustomThemes } from "../../../../../test/helpers/theme-helpers";
import { registerHighlightWorker } from "./worker";

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

/** Build an added-file diff whose every line lands on the addition side, as generated output does. */
function createGeneratedFileDiff(contents: string): DiffFile {
  const metadata = parseDiffFromFile(
    { name: "bun.lock", contents: "", cacheKey: "generated:before" },
    { name: "bun.lock", contents, cacheKey: "generated:after" },
    { context: 3 },
    true,
  );

  return {
    id: "generated",
    path: "bun.lock",
    patch: "",
    language: "json",
    stats: { additions: metadata.additionLines.length, deletions: 0 },
    metadata,
    agent: null,
  };
}

const ELIXIR_HEREDOC_BEFORE = `defmodule Repro do
  @doc """
  Line one.
  Line two.
  Line three.
  Line four.
  Line five.
  """
  def hello do
    :world
  end
end
`;
const ELIXIR_HEREDOC_AFTER = ELIXIR_HEREDOC_BEFORE.replace("Line five.", "Line five, edited.");
const ELIXIR_HEREDOC_PATCH = `diff --git a/repro.ex b/repro.ex
--- a/repro.ex
+++ b/repro.ex
@@ -4,9 +4,9 @@
   Line two.
   Line three.
   Line four.
-  Line five.
+  Line five, edited.
   """
   def hello do
     :world
   end
 end
`;

/** Build issue #664's partial Elixir diff with optional authoritative source text. */
function createElixirHeredocDiffFile(sourceFetcher?: DiffFile["sourceFetcher"]): DiffFile {
  const metadata = parsePatchFiles(ELIXIR_HEREDOC_PATCH, "issue-664", true)[0]?.files[0];
  if (!metadata) {
    throw new Error("Expected issue #664 patch metadata");
  }

  return {
    id: "issue-664",
    path: "repro.ex",
    patch: ELIXIR_HEREDOC_PATCH,
    language: "elixir",
    stats: { additions: 1, deletions: 1 },
    metadata,
    agent: null,
    sourceFetcher,
  };
}

/** Build a changed TypeScript file at or above the interactive worker threshold. */
function createWorkerEligibleDiffFile(generatedLineCount = HIGHLIGHT_WORKER_MIN_LINES): DiffFile {
  const additions = Array.from(
    { length: generatedLineCount },
    (_, index) => `export const generated${index} = ${index};`,
  ).join("\n");
  const metadata = parseDiffFromFile(
    {
      name: "large.ts",
      contents: "export const changed = 1;\n",
      cacheKey: "large-before",
    },
    {
      name: "large.ts",
      contents: `export const changed = 2;\n${additions}\n`,
      cacheKey: "large-after",
    },
    { context: 3 },
    true,
  );

  return {
    id: "large",
    path: "large.ts",
    patch: "",
    language: "typescript",
    stats: { additions: generatedLineCount + 1, deletions: 1 },
    metadata,
    agent: null,
  };
}

/** Build a large partial source diff that must remap compact full-source ranges onto its patch. */
function createLargeSourceBackedDiffFile(prefixLineCount = HIGHLIGHT_WORKER_MIN_LINES): DiffFile {
  const prefix = Array.from(
    { length: prefixLineCount },
    (_, index) => `  value${index} = ${index}`,
  ).join("\n");
  const before = `${prefix}\n${ELIXIR_HEREDOC_BEFORE}`;
  const after = before.replace("Line five.", "Line five, edited.");
  const patch = createTwoFilesPatch("large.ex", "large.ex", before, after, "", "", { context: 3 });
  const metadata = parsePatchFiles(patch, "large-source", true)[0]?.files[0];
  if (!metadata) {
    throw new Error("Expected large source-backed metadata");
  }

  return {
    id: "large-source",
    path: "large.ex",
    patch,
    language: "elixir",
    stats: { additions: 1, deletions: 1 },
    metadata,
    agent: null,
    sourceFetcher: createTestSourceFetcher((side) => (side === "old" ? before : after)),
  };
}

/** Register a worker double that reports a startup failure as soon as it receives work. */
function registerFailingHighlightWorkerForTest() {
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage() {
      this.onerror?.({ message: "test worker failure" } as ErrorEvent);
    },
    terminate() {
      return Promise.resolve(0);
    },
    unref() {},
  };
  registerHighlightWorker(worker as unknown as Worker);
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

  test("renders a generated-scale diff as plain rows instead of highlighting it", async () => {
    const generatedLines = Array.from(
      { length: 12_000 },
      (_, index) => `  "package-${index}": "npm:package-${index}@1.0.${index}",`,
    ).join("\n");
    const file = createGeneratedFileDiff(`{\n${generatedLines}\n}\n`);
    const theme = resolveTheme("github-dark-default", null);

    expect(shouldHighlightDiff(file)).toBe(false);
    expect(highlightedDiffLineCount(file.metadata)).toBeGreaterThan(10_000);

    const highlighted = await loadHighlightedDiff(file, theme);

    expect(highlighted.deletionLines).toHaveLength(0);
    expect(highlighted.additionLines).toHaveLength(0);

    // Plain rows still carry the diff itself, so the file stays reviewable without color.
    const rows = buildStackRows(file, highlighted, theme);
    expect(rows.some((row) => row.type === "stack-line")).toBe(true);

    // A source file of ordinary size is unaffected.
    expect(shouldHighlightDiff(createDiffFile())).toBe(true);
  });

  test("offloads bundled-theme highlighting starting at 40 source lines", () => {
    const eligible = createWorkerEligibleDiffFile(HIGHLIGHT_WORKER_MIN_LINES - 1);
    const belowThreshold = createWorkerEligibleDiffFile(HIGHLIGHT_WORKER_MIN_LINES - 2);
    const theme = resolveTheme("github-dark-default", null);

    expect(HIGHLIGHT_WORKER_MIN_LINES).toBe(40);
    expect(
      Math.max(eligible.metadata.deletionLines.length, eligible.metadata.additionLines.length),
    ).toBe(40);
    expect(
      Math.max(
        belowThreshold.metadata.deletionLines.length,
        belowThreshold.metadata.additionLines.length,
      ),
    ).toBe(39);
    expect(shouldOffloadHighlight(eligible.metadata, theme, { offloadLargeDiff: true })).toBe(true);
    expect(shouldOffloadHighlight(belowThreshold.metadata, theme, { offloadLargeDiff: true })).toBe(
      false,
    );
    expect(shouldOffloadHighlight(eligible.metadata, theme, { offloadLargeDiff: false })).toBe(
      false,
    );
  });

  test("matches inline spans when an eligible bundled-theme diff uses the worker", async () => {
    const file = createWorkerEligibleDiffFile();
    const theme = resolveTheme("github-dark-default", null);

    expect(shouldOffloadHighlight(file.metadata, theme, { offloadLargeDiff: true })).toBe(true);

    const [inline, offloaded] = await Promise.all([
      loadHighlightedDiff(file, theme),
      loadHighlightedDiff(file, theme, { offloadLargeDiff: true }),
    ]);
    const inlineRows = buildSplitRows(file, inline, theme);
    const workerRows = buildSplitRows(file, offloaded, theme);

    expect(offloaded.deletionLines).toEqual([]);
    expect(offloaded.additionLines).toEqual([]);
    expect(offloaded.compact?.payload.foregroundPalette.length).toBeGreaterThan(0);
    expect(workerRows).toEqual(inlineRows);
    const changedRow = workerRows.find(
      (row) =>
        row.type === "split-line" && row.left.kind === "deletion" && row.right.kind === "addition",
    );
    expect(
      changedRow?.type === "split-line" && changedRow.right.spans.some((span) => span.bg),
    ).toBe(true);
  }, 30_000);

  test("maps compact full-source worker ranges back onto a partial patch", async () => {
    const file = createLargeSourceBackedDiffFile();
    const theme = resolveTheme("github-dark-default", null);

    const [inline, offloaded] = await Promise.all([
      loadHighlightedDiff(file, theme),
      loadHighlightedDiff(file, theme, { offloadLargeDiff: true }),
    ]);

    expect(offloaded.compact?.deletionLineMap).toHaveLength(file.metadata.deletionLines.length);
    expect(offloaded.compact?.additionLineMap).toHaveLength(file.metadata.additionLines.length);
    expect(buildStackRows(file, offloaded, theme)).toEqual(buildStackRows(file, inline, theme));
  }, 30_000);

  test("falls back to plain spans for an out-of-range compact source mapping", () => {
    const file = createDiffFile();
    const theme = resolveTheme("github-dark-default", null);
    const emptySide = {
      lineOffsets: Uint32Array.of(0, 0),
      starts: new Uint32Array(),
      ends: new Uint32Array(),
      styleIds: new Uint16Array(),
      flags: new Uint8Array(),
    };
    const highlighted = {
      deletionLines: [],
      additionLines: [],
      compact: {
        payload: {
          version: 1 as const,
          foregroundPalette: [],
          deletion: emptySide,
          addition: emptySide,
        },
        deletionLineMap: Array.from({ length: file.metadata.deletionLines.length }, () => 10_000),
        additionLineMap: Array.from({ length: file.metadata.additionLines.length }, () => 10_000),
      },
    };

    let rows: ReturnType<typeof buildSplitRows> = [];
    expect(() => {
      rows = buildSplitRows(file, highlighted, theme);
    }).not.toThrow();
    const changedRow = rows.find(
      (row) =>
        row.type === "split-line" && row.left.kind === "deletion" && row.right.kind === "addition",
    );
    expect(changedRow?.type).toBe("split-line");
    expect(
      changedRow?.type === "split-line" ? changedRow.left.spans.some((span) => span.fg) : true,
    ).toBe(false);
  });

  test("matches inline context styling for a large patch-only diff", async () => {
    const context = Array.from(
      { length: HIGHLIGHT_WORKER_MIN_LINES },
      (_, index) => `const gap${index} = ${index};`,
    );
    const before = [`const message = "closed";`, ...context, "const target = 1;", ""].join("\n");
    const after = ["const message = `open", ...context, "const target = 2;`", ""].join("\n");
    const patch = createTwoFilesPatch("state.ts", "state.ts", before, after, "", "", {
      context: HIGHLIGHT_WORKER_MIN_LINES + 2,
    });
    const metadata = parsePatchFiles(patch, "large-patch-only-state", true)[0]?.files[0];
    if (!metadata) {
      throw new Error("Expected large patch-only grammar-state metadata");
    }
    const file: DiffFile = {
      id: "large-patch-only-state",
      path: "state.ts",
      patch,
      language: "typescript",
      stats: { additions: 2, deletions: 2 },
      metadata,
      agent: null,
    };
    const theme = resolveTheme("github-dark-default", null);

    const [inline, offloaded] = await Promise.all([
      loadHighlightedDiff(file, theme),
      loadHighlightedDiff(file, theme, { offloadLargeDiff: true }),
    ]);

    expect(offloaded.compact).toBeDefined();
    expect(buildSplitRows(file, offloaded, theme)).toEqual(buildSplitRows(file, inline, theme));
  }, 30_000);

  test("falls back to patch highlighting when source-backed metadata exceeds the cap", async () => {
    // A 6,000-line file produces 12,000 full-source side lines, although the visible patch has
    // only one changed line. It should use the safe patch fragment rather than render plain rows.
    const file = createLargeSourceBackedDiffFile(6_000);
    const theme = resolveTheme("github-dark-default", null);
    const highlighted = await loadHighlightedDiff(file, theme);
    const rows = buildStackRows(file, highlighted, theme);
    const functionRow = rows.find(
      (row) =>
        row.type === "stack-line" && row.cell.spans.some((span) => span.text.includes("def hello")),
    );

    expect(shouldHighlightDiff(file)).toBe(true);
    expect(highlighted.deletionLines).toHaveLength(file.metadata.deletionLines.length);
    expect(highlighted.additionLines).toHaveLength(file.metadata.additionLines.length);
    expect(functionRow?.type).toBe("stack-line");
    expect(functionRow?.type === "stack-line" ? functionRow.cell.spans[0]?.fg : undefined).toBe(
      "#A5D6FF",
    );
  });

  test("falls back to plain text when the highlight worker fails", async () => {
    registerFailingHighlightWorkerForTest();
    const file = createWorkerEligibleDiffFile();
    const theme = resolveTheme("github-dark-default", null);

    await expect(loadHighlightedDiff(file, theme, { offloadLargeDiff: true })).resolves.toEqual({
      deletionLines: [],
      additionLines: [],
      retryable: true,
    });
  });

  test("uses full source to keep partial Elixir hunks inside the correct heredoc state", async () => {
    const sourceFetcher = createTestSourceFetcher((side) =>
      side === "old" ? ELIXIR_HEREDOC_BEFORE : ELIXIR_HEREDOC_AFTER,
    );
    const file = createElixirHeredocDiffFile(sourceFetcher);
    const theme = resolveTheme("github-dark-default", null);
    const highlighted = await loadHighlightedDiff(file, theme);
    const rows = buildStackRows(file, highlighted, theme);
    const rowFor = (text: string) =>
      rows.find(
        (row) =>
          row.type === "stack-line" && row.cell.spans.some((span) => span.text.includes(text)),
      );
    const docRow = rowFor("Line two.");
    const functionRow = rowFor("def");
    const additionRow = rowFor("edited");

    expect(sourceFetcher.calls).toEqual(["old", "new"]);
    expect(docRow?.type === "stack-line" ? docRow.cell.spans[0]?.fg : undefined).toBe("#8B949E");
    expect(
      functionRow?.type === "stack-line"
        ? functionRow.cell.spans.find((span) => span.text.includes("def"))?.fg
        : undefined,
    ).toBe("#FF7B72");
    expect(
      additionRow?.type === "stack-line"
        ? additionRow.cell.spans.find((span) => span.text.includes("edited"))?.bg
        : undefined,
    ).toBeDefined();
  });

  test("falls back to patch-fragment highlighting when authoritative source cannot load", async () => {
    const sourceFetcher = createTestSourceFetcher(() => {
      throw new Error("source unavailable");
    });
    const file = createElixirHeredocDiffFile(sourceFetcher);
    const theme = resolveTheme("github-dark-default", null);
    const highlighted = await loadHighlightedDiff(file, theme);
    const rows = buildStackRows(file, highlighted, theme);
    const functionRow = rows.find(
      (row) =>
        row.type === "stack-line" && row.cell.spans.some((span) => span.text.includes("def hello")),
    );

    expect(sourceFetcher.calls).toEqual(["old", "new"]);
    expect(functionRow?.type).toBe("stack-line");
    expect(functionRow?.type === "stack-line" ? functionRow.cell.spans[0]?.fg : undefined).toBe(
      "#A5D6FF",
    );
  });

  test("preserves different old and new grammar states across partial diff hunks", async () => {
    const oldText = [
      'const message = "closed";',
      ...Array.from({ length: 8 }, (_, index) => `const gap${index + 1} = ${index + 1};`),
      "const target = 1;",
      "",
    ].join("\n");
    const newText = [
      "const message = `open",
      ...Array.from({ length: 8 }, (_, index) => `const gap${index + 1} = ${index + 1};`),
      "const target = 2;`;",
      "",
    ].join("\n");
    const patch = createTwoFilesPatch("state.ts", "state.ts", oldText, newText, "", "", {
      context: 1,
    });
    const metadata = parsePatchFiles(patch, "grammar-state", true)[0]?.files[0];
    if (!metadata) {
      throw new Error("Expected partial grammar-state metadata");
    }
    const sourceFetcher = createTestSourceFetcher((side) => (side === "old" ? oldText : newText));
    const file: DiffFile = {
      id: "grammar-state",
      path: "state.ts",
      patch,
      language: "typescript",
      stats: { additions: 2, deletions: 2 },
      metadata,
      agent: null,
      sourceFetcher,
    };
    const theme = resolveTheme("github-dark-default", null);
    const highlighted = await loadHighlightedDiff(file, theme);
    const rows = buildSplitRows(file, highlighted, theme);
    const contextRow = rows.find(
      (row) =>
        row.type === "split-line" &&
        row.left.spans.some((span) => span.text.includes("gap8")) &&
        row.right.spans.some((span) => span.text.includes("gap8")),
    );

    expect(contextRow?.type).toBe("split-line");
    if (!contextRow || contextRow.type !== "split-line") {
      throw new Error("Expected second-hunk context row");
    }
    expect(contextRow.left.spans.map((span) => span.fg)).not.toEqual(
      contextRow.right.spans.map((span) => span.fg),
    );
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

  test("expands highlighted tabs across syntax span boundaries for each configured width", async () => {
    const metadata = parseDiffFromFile(
      { name: "tabs.ts", contents: "let a\t= 1;\n", cacheKey: "tabs-before" },
      { name: "tabs.ts", contents: "let a\t= 2;\n", cacheKey: "tabs-after" },
      { context: 3 },
      true,
    );
    const file: DiffFile = {
      id: "tabs",
      path: "tabs.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 1, deletions: 1 },
      metadata,
      agent: null,
    };
    const theme = resolveTheme("github-dark-default", null);
    const highlighted = await loadHighlightedDiff(file, theme);
    const addedText = (tabWidth: number) => {
      const row = buildStackRows(file, highlighted, theme, tabWidth).find(
        (candidate) => candidate.type === "stack-line" && candidate.cell.kind === "addition",
      );
      if (!row || row.type !== "stack-line") {
        throw new Error("expected one highlighted addition row");
      }
      return row.cell.spans.map((span) => span.text).join("");
    };

    expect(addedText(2)).toBe("let a = 2;");
    expect(addedText(4)).toBe("let a   = 2;");
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
    const firstTheme = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "nord",
        syntaxScopes: {
          "comment.line.double-slash.ts": "#abcdef",
          "punctuation.definition.comment.ts": "#abcdef",
        },
      }),
    );
    const secondTheme = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "nord",
        syntaxScopes: {
          "comment.line.double-slash.ts": "#fedcba",
          "punctuation.definition.comment.ts": "#fedcba",
        },
      }),
    );
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
      const theme = resolveTheme(
        "custom",
        null,
        createTestCustomThemes({
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
        }),
      );
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
    const customTheme = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "nord",
        syntaxScopes: {
          "comment.line.double-slash.ts": "#abcdef",
          "punctuation.definition.comment.ts": "#abcdef",
        },
      }),
    );
    const nextCustomTheme = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "nord",
        syntaxScopes: {
          "comment.line.double-slash.ts": "#fedcba",
          "punctuation.definition.comment.ts": "#fedcba",
        },
      }),
    );
    const variableTheme = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "nord",
        syntaxScopes: { "variable.other.object.ts": "#030303" },
      }),
    );
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
    const customTheme = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "everforest-dark",
        syntaxScopes: { "keyword.operator": "#123456" },
      }),
    );
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
