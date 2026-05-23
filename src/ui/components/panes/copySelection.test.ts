import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../../../core/types";
import { resolveTheme } from "../../themes";
import { measureDiffSectionGeometry } from "../../diff/diffSectionGeometry";
import { buildFileSectionLayouts } from "../../lib/fileSectionLayout";
import {
  buildCopySelectedRowKeys,
  clampCopyColumn,
  copySelectionPointsEqual,
  copySelectionPointsShareRow,
  expandSelectionPoint,
  findCopySelectionPoint,
  normalizeCopySelectionRange,
  renderCopySelectionText,
  resolveCopySelectionSide,
  type CopySelectionContext,
  type CopySelectionDrag,
  type CopySelectionPoint,
} from "./copySelection";
import {
  DIFF_RAIL_PREFIX_WIDTH,
  resolveStackCellGeometry,
  resolveSplitPaneWidths,
} from "../../diff/codeColumns";

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

function buildContext(
  layout: "stack" | "split" = "stack",
  width = 120,
): {
  context: CopySelectionContext;
  fileSectionLayouts: ReturnType<typeof buildFileSectionLayouts>;
  sectionGeometry: ReturnType<typeof measureDiffSectionGeometry>[];
} {
  const theme = resolveTheme("midnight", null);
  const file = createDiffFile();
  const geometry = measureDiffSectionGeometry(file, layout, true, theme, [], width, true, false);
  const sectionGeometry = [geometry];
  const fileSectionLayouts = buildFileSectionLayouts([file], [geometry.bodyHeight]);

  const context: CopySelectionContext = {
    codeHorizontalOffset: 0,
    copyDecorations: true,
    files: [file],
    fileSectionLayouts,
    headerLabelWidth: 60,
    headerStatsWidth: 12,
    layout,
    pinnedHeaderFile: file,
    sectionGeometry,
    showHunkHeaders: true,
    showLineNumbers: true,
    theme,
    width,
    wrapLines: false,
  };

  return { context, fileSectionLayouts, sectionGeometry };
}

describe("clampCopyColumn", () => {
  test("clamps below zero to zero", () => {
    expect(clampCopyColumn(-5, 10)).toBe(0);
  });

  test("clamps above the rendered width", () => {
    expect(clampCopyColumn(99, 10)).toBe(9);
  });

  test("returns zero when width is zero", () => {
    expect(clampCopyColumn(5, 0)).toBe(0);
  });
});

describe("copySelectionPointsEqual", () => {
  test("rejects different kinds even at the same column", () => {
    const a: CopySelectionPoint = { kind: "review-row", column: 1, visualRow: 1 };
    const b: CopySelectionPoint = {
      kind: "pinned-header",
      column: 1,
      fileId: "example",
      nextVisualRow: 1,
    };
    expect(copySelectionPointsEqual(a, b)).toBe(false);
  });

  test("matches identical review-row points", () => {
    const a: CopySelectionPoint = { kind: "review-row", column: 2, visualRow: 4 };
    const b: CopySelectionPoint = { kind: "review-row", column: 2, visualRow: 4 };
    expect(copySelectionPointsEqual(a, b)).toBe(true);
  });

  test("treats pinned-header points with different file ids as distinct", () => {
    const a: CopySelectionPoint = {
      kind: "pinned-header",
      column: 0,
      fileId: "one",
      nextVisualRow: 0,
    };
    const b: CopySelectionPoint = {
      kind: "pinned-header",
      column: 0,
      fileId: "two",
      nextVisualRow: 0,
    };
    expect(copySelectionPointsEqual(a, b)).toBe(false);
  });
});

describe("copySelectionPointsShareRow", () => {
  test("matches review-row points on the same visual row", () => {
    const a: CopySelectionPoint = { kind: "review-row", column: 2, visualRow: 4 };
    const b: CopySelectionPoint = { kind: "review-row", column: 20, visualRow: 4 };
    expect(copySelectionPointsShareRow(a, b)).toBe(true);
  });

  test("rejects review-row points on different visual rows", () => {
    const a: CopySelectionPoint = { kind: "review-row", column: 2, visualRow: 4 };
    const b: CopySelectionPoint = { kind: "review-row", column: 2, visualRow: 5 };
    expect(copySelectionPointsShareRow(a, b)).toBe(false);
  });
});

describe("normalizeCopySelectionRange", () => {
  test("orders forward selections by row then column", () => {
    const anchor: CopySelectionPoint = { kind: "review-row", column: 2, visualRow: 1 };
    const focus: CopySelectionPoint = { kind: "review-row", column: 8, visualRow: 1 };
    const { start, end } = normalizeCopySelectionRange(anchor, focus);
    expect(start).toBe(anchor);
    expect(end).toBe(focus);
  });

  test("flips reverse selections so start <= end", () => {
    const anchor: CopySelectionPoint = { kind: "review-row", column: 5, visualRow: 3 };
    const focus: CopySelectionPoint = { kind: "review-row", column: 2, visualRow: 1 };
    const { start, end } = normalizeCopySelectionRange(anchor, focus);
    expect(start).toBe(focus);
    expect(end).toBe(anchor);
  });

  test("sorts a pinned-header point above its body", () => {
    const header: CopySelectionPoint = {
      kind: "pinned-header",
      column: 0,
      fileId: "example",
      nextVisualRow: 2,
    };
    const body: CopySelectionPoint = { kind: "review-row", column: 0, visualRow: 2 };
    const { start, end } = normalizeCopySelectionRange(body, header);
    expect(start).toBe(header);
    expect(end).toBe(body);
  });
});

describe("findCopySelectionPoint", () => {
  test("returns a review-row point for a row inside the body", () => {
    const { context, fileSectionLayouts, sectionGeometry } = buildContext();
    const probeRow = fileSectionLayouts[0]!.bodyTop;
    const point = findCopySelectionPoint({
      column: 4,
      copyDecorations: true,
      fileSectionLayouts,
      sectionGeometry,
      visualRow: probeRow,
      width: context.width,
    });

    expect(point).not.toBeNull();
    expect(point?.kind).toBe("review-row");
    expect(point?.visualRow).toBe(probeRow);
    expect(point?.column).toBe(4);
  });

  test("returns null for rows past the end of the stream", () => {
    const { context, fileSectionLayouts, sectionGeometry } = buildContext();
    const lastLayout = fileSectionLayouts[fileSectionLayouts.length - 1]!;

    const point = findCopySelectionPoint({
      column: 0,
      copyDecorations: true,
      fileSectionLayouts,
      sectionGeometry,
      visualRow: lastLayout.sectionBottom + 50,
      width: context.width,
    });

    expect(point).toBeNull();
  });
});

describe("renderCopySelectionText", () => {
  test("produces decorated text for a single-row drag", () => {
    const { context, fileSectionLayouts } = buildContext();
    const start: CopySelectionPoint = {
      kind: "review-row",
      column: 0,
      visualRow: fileSectionLayouts[0]!.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: context.width - 1,
      visualRow: fileSectionLayouts[0]!.bodyTop,
    };

    const text = renderCopySelectionText({ context, start, end });
    expect(text.length).toBeGreaterThan(0);
    // Decorated output keeps the diff rail marker at the row prefix.
    expect(text.startsWith("▌")).toBe(true);
  });

  test("strips all decorations when copyDecorations is disabled", () => {
    const { context, fileSectionLayouts } = buildContext();
    const undecoratedContext: CopySelectionContext = { ...context, copyDecorations: false };

    const start: CopySelectionPoint = {
      kind: "review-row",
      column: 0,
      visualRow: fileSectionLayouts[0]!.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: undecoratedContext.width - 1,
      visualRow: fileSectionLayouts[0]!.sectionBottom - 1,
    };

    const text = renderCopySelectionText({ context: undecoratedContext, start, end });
    expect(text).not.toContain("▌");
    expect(text).toContain("export const answer = 41;");
    expect(text).toContain("export const answer = 42;");
  });

  test("code-only single-row selections preserve selected columns", () => {
    const { context, fileSectionLayouts, sectionGeometry } = buildContext("stack");
    const section = fileSectionLayouts[0]!;
    const geometry = sectionGeometry[0]!;
    const rowIndex = geometry.plannedRows.findIndex(
      (row) => row.kind === "diff-row" && row.row.type === "stack-line",
    );
    const visualRow = section.bodyTop + geometry.rowBounds[rowIndex]!.top;
    const { gutterWidth } = resolveStackCellGeometry(
      context.width,
      geometry.lineNumberDigits,
      context.showLineNumbers,
      DIFF_RAIL_PREFIX_WIDTH,
    );
    const codeStart = DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    const undecoratedContext: CopySelectionContext = { ...context, copyDecorations: false };

    const text = renderCopySelectionText({
      context: undecoratedContext,
      start: { kind: "review-row", column: codeStart + 7, visualRow },
      end: { kind: "review-row", column: codeStart + 11, visualRow },
    });

    expect(text).toBe("const");
  });

  test("includes the pinned header when the drag starts in it", () => {
    const { context, fileSectionLayouts } = buildContext();
    const start: CopySelectionPoint = {
      kind: "pinned-header",
      column: 0,
      fileId: "example",
      nextVisualRow: fileSectionLayouts[0]!.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: context.width - 1,
      visualRow: fileSectionLayouts[0]!.bodyTop,
    };

    const text = renderCopySelectionText({ context, start, end });
    expect(text).toContain("example.ts");
  });
});

describe("resolveCopySelectionSide", () => {
  test("returns undefined in stack layout", () => {
    expect(resolveCopySelectionSide(10, "stack", 120)).toBeUndefined();
    expect(resolveCopySelectionSide(80, "stack", 120)).toBeUndefined();
  });

  test("returns 'left' for columns inside the split left pane", () => {
    expect(resolveCopySelectionSide(0, "split", 120)).toBe("left");
    expect(resolveCopySelectionSide(10, "split", 120)).toBe("left");
  });

  test("returns 'right' for columns at or past the split midpoint", () => {
    expect(resolveCopySelectionSide(100, "split", 120)).toBe("right");
  });
});

describe("renderCopySelectionText with side", () => {
  test("includes only the left side text when side is 'left' and decorations are off", () => {
    const { context, fileSectionLayouts } = buildContext("split");
    const splitContext: CopySelectionContext = {
      ...context,
      copyDecorations: false,
    };
    const start: CopySelectionPoint = {
      kind: "review-row",
      column: 0,
      visualRow: fileSectionLayouts[0]!.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: 10,
      visualRow: fileSectionLayouts[0]!.sectionBottom - 1,
    };

    const text = renderCopySelectionText({
      context: splitContext,
      start,
      end,
      side: "left",
    });
    expect(text).toContain("export const answer = 41;");
    expect(text).not.toContain("export const answer = 42;");
  });

  test("includes only the right side text when side is 'right' and decorations are off", () => {
    const { context, fileSectionLayouts } = buildContext("split");
    const splitContext: CopySelectionContext = {
      ...context,
      copyDecorations: false,
    };
    const start: CopySelectionPoint = {
      kind: "review-row",
      column: 0,
      visualRow: fileSectionLayouts[0]!.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: 10,
      visualRow: fileSectionLayouts[0]!.sectionBottom - 1,
    };

    const text = renderCopySelectionText({
      context: splitContext,
      start,
      end,
      side: "right",
    });
    expect(text).toContain("export const answer = 42;");
    expect(text).not.toContain("export const answer = 41;");
  });
});

describe("buildCopySelectedRowKeys", () => {
  test("returns an empty map when the drag has not moved", () => {
    const { fileSectionLayouts, sectionGeometry } = buildContext();
    const point: CopySelectionPoint = { kind: "review-row", column: 0, visualRow: 0 };
    const drag: CopySelectionDrag = { anchor: point, focus: point, moved: false };

    expect(
      buildCopySelectedRowKeys({ drag, fileSectionLayouts, sectionGeometry, width: 120 }).size,
    ).toBe(0);
  });

  test("collects every row key intersected by a multi-row drag", () => {
    const { fileSectionLayouts, sectionGeometry } = buildContext();
    const firstLayout = fileSectionLayouts[0]!;
    const anchor: CopySelectionPoint = {
      kind: "review-row",
      column: 0,
      visualRow: firstLayout.bodyTop,
    };
    const focus: CopySelectionPoint = {
      kind: "review-row",
      column: 0,
      visualRow: firstLayout.sectionBottom - 1,
    };

    const map = buildCopySelectedRowKeys({
      drag: { anchor, focus, moved: true },
      fileSectionLayouts,
      sectionGeometry,
      width: 120,
    });

    const rows = map.get("example");
    expect(rows).toBeDefined();
    expect(rows?.size ?? 0).toBeGreaterThan(0);
  });
});

describe("expandSelectionPoint", () => {
  test("triple-click with code-only copy selects the code line", () => {
    const { context, fileSectionLayouts, sectionGeometry } = buildContext("stack");
    const section = fileSectionLayouts[0]!;
    const geometry = sectionGeometry[0]!;
    const undecoratedContext: CopySelectionContext = { ...context, copyDecorations: false };
    const { gutterWidth } = resolveStackCellGeometry(
      context.width,
      geometry.lineNumberDigits,
      context.showLineNumbers,
      DIFF_RAIL_PREFIX_WIDTH,
    );
    const globalContentStart = DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    const lineText = "export const answer = 42;";
    const point: CopySelectionPoint = {
      kind: "review-row",
      column: globalContentStart + 10,
      visualRow: section.bodyTop + 2,
    };

    const result = expandSelectionPoint(point, 3, undecoratedContext);

    expect(result).toEqual({
      startCol: globalContentStart,
      endCol: globalContentStart + lineText.length - 1,
    });
  });

  test("triple-click in stack selects the full width", () => {
    const { context, fileSectionLayouts } = buildContext("stack");
    const section = fileSectionLayouts[0]!;
    const point: CopySelectionPoint = {
      kind: "review-row",
      column: 40,
      visualRow: section.bodyTop,
    };
    const result = expandSelectionPoint(point, 3, context);
    expect(result).toEqual({ startCol: 0, endCol: context.width - 1 });
  });

  test("triple-click in split on left side stays within left pane", () => {
    const { context, fileSectionLayouts } = buildContext("split");
    const { leftWidth } = resolveSplitPaneWidths(context.width);
    const section = fileSectionLayouts[0]!;
    // Column clearly inside the left pane
    const point: CopySelectionPoint = {
      kind: "review-row",
      column: 5,
      visualRow: section.bodyTop,
    };
    const result = expandSelectionPoint(point, 3, context);
    expect(result).not.toBeNull();
    if (result) {
      // Left side: columns 0..leftWidth-1
      expect(result.startCol).toBe(0);
      expect(result.endCol).toBe(leftWidth - 1);

      // The anchor/focus side must remain "left"
      const side = resolveCopySelectionSide(result.startCol, "split", context.width);
      expect(side).toBe("left");
    }
  });

  test("triple-click in split on right side stays within right pane", () => {
    const { context, fileSectionLayouts } = buildContext("split");
    const { leftWidth } = resolveSplitPaneWidths(context.width);
    const section = fileSectionLayouts[0]!;
    // Column clearly inside the right pane
    const point: CopySelectionPoint = {
      kind: "review-row",
      column: leftWidth + DIFF_RAIL_PREFIX_WIDTH + 1,
      visualRow: section.bodyTop,
    };
    const result = expandSelectionPoint(point, 3, context);
    expect(result).not.toBeNull();
    if (result) {
      // Right side: columns leftWidth..width-1
      expect(result.startCol).toBe(leftWidth);
      expect(result.endCol).toBe(context.width - 1);

      // The anchor/focus side must remain "right"
      const side = resolveCopySelectionSide(result.startCol, "split", context.width);
      expect(side).toBe("right");
    }
  });

  test("double-click on whitespace selects the whitespace character itself", () => {
    const { context, fileSectionLayouts, sectionGeometry } = buildContext("stack");
    const section = fileSectionLayouts[0]!;
    const geometry = sectionGeometry[0]!;

    // Compute the global column for the space character between "export" and "const".
    // The addition row "export const answer = 42;" starts at bodyTop + 2
    // (after a hunk header row and a deletion row).
    const { gutterWidth } = resolveStackCellGeometry(
      context.width,
      geometry.lineNumberDigits,
      context.showLineNumbers,
      DIFF_RAIL_PREFIX_WIDTH,
    );
    const globalContentStart = DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    // "export" is 6 chars, so the space after it is at code-local column 6.
    const spaceCol = globalContentStart + 6;

    const point: CopySelectionPoint = {
      kind: "review-row",
      column: spaceCol,
      visualRow: section.bodyTop + 2, // addition row: "export const answer = 42;"
    };

    const result = expandSelectionPoint(point, 2, context);
    expect(result).not.toBeNull();
    if (result) {
      // startCol and endCol should be equal (single whitespace character),
      // never inverted (endCol < startCol).
      expect(result.startCol).toBeLessThanOrEqual(result.endCol);
      expect(result.startCol).toBe(spaceCol);
      expect(result.endCol).toBe(spaceCol);
    }
  });

  test("double-click on a word stops at code punctuation", () => {
    const { context, fileSectionLayouts, sectionGeometry } = buildContext("stack");
    const section = fileSectionLayouts[0]!;
    const geometry = sectionGeometry[0]!;
    const { gutterWidth } = resolveStackCellGeometry(
      context.width,
      geometry.lineNumberDigits,
      context.showLineNumbers,
      DIFF_RAIL_PREFIX_WIDTH,
    );
    const globalContentStart = DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    const numberCol = globalContentStart + 22;
    const point: CopySelectionPoint = {
      kind: "review-row",
      column: numberCol,
      visualRow: section.bodyTop + 2,
    };

    const result = expandSelectionPoint(point, 2, context);

    expect(result).toEqual({
      startCol: numberCol,
      endCol: numberCol + 1,
    });
  });
});

describe("renderCopySelectionText in split with side", () => {
  test("B side text with copyDecorations=true uses correct column offsets", () => {
    const { context, fileSectionLayouts } = buildContext("split");
    const section = fileSectionLayouts[0]!;
    const { leftWidth } = resolveSplitPaneWidths(context.width);

    // B (right) side first body row, column inside the right pane
    const start: CopySelectionPoint = {
      kind: "review-row",
      column: leftWidth + DIFF_RAIL_PREFIX_WIDTH + 1,
      visualRow: section.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: leftWidth + DIFF_RAIL_PREFIX_WIDTH + 1,
      visualRow: section.sectionBottom - 1,
    };

    // With decorations enabled and side="right", the text must be non-empty
    // and should contain B-side content ("export const answer = 42")
    const text = renderCopySelectionText({
      context,
      start,
      end,
      side: "right",
    });
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("export const answer = 42;");
  });

  test("A side text with copyDecorations=true stays intact", () => {
    const { context, fileSectionLayouts } = buildContext("split");
    const section = fileSectionLayouts[0]!;

    const start: CopySelectionPoint = {
      kind: "review-row",
      column: DIFF_RAIL_PREFIX_WIDTH + 1,
      visualRow: section.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: DIFF_RAIL_PREFIX_WIDTH + 1,
      visualRow: section.sectionBottom - 1,
    };

    const text = renderCopySelectionText({
      context,
      start,
      end,
      side: "left",
    });
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("export const answer = 41;");
    expect(text).not.toContain("export const answer = 42;");
  });

  test("decorated B side multi-line selection includes all lines", () => {
    const { context, fileSectionLayouts } = buildContext("split");
    const section = fileSectionLayouts[0]!;
    const { leftWidth } = resolveSplitPaneWidths(context.width);

    // B side: select first row to last row
    const start: CopySelectionPoint = {
      kind: "review-row",
      column: leftWidth + DIFF_RAIL_PREFIX_WIDTH + 1,
      visualRow: section.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: context.width - 1,
      visualRow: section.sectionBottom - 1,
    };

    const text = renderCopySelectionText({
      context,
      start,
      end,
      side: "right",
    });
    expect(text.length).toBeGreaterThan(0);
    // First line should be included
    expect(text).toContain("export const answer = 42;");
  });
});
