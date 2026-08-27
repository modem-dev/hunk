import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../../../core/changeset/model";
import { resolveTheme } from "../../themes";
import { measureDiffSectionGeometry } from "../../diff/diffSectionGeometry";
import { planCodeRowLayout } from "../../diff/codeRowLayout";
import { buildFileSectionLayouts } from "../../lib/fileSectionLayout";
import {
  buildCopySelectedRowKeys,
  clampCopyColumn,
  copySelectionDragIsClick,
  copySelectionPointsEqual,
  copySelectionPointsShareRow,
  expandSelectionPoint,
  findCopySelectionPoint,
  findLineCursorForClick,
  normalizeCopySelectionRange,
  renderCopySelectionText,
  resolveCopySelectionSide,
  type CopySelectionContext,
  type CopySelectionDrag,
  type CopySelectionPoint,
  type CopySelectionSide,
} from "./copySelection";
import {
  DIFF_RAIL_PREFIX_WIDTH,
  resolveSplitCellGeometry,
  resolveStackCellGeometry,
  resolveSplitPaneWidths,
} from "../../diff/codeColumns";
import { measureTextWidth } from "../../lib/text";
import { buildLineCursors } from "../../lib/lineCursors";

const OSC52_CLIPBOARD = "\x1b]52;c;SGVsbG8=\x07";
const CSI_CLEAR_SCREEN = "\x1b[2J";
const DCS_PAYLOAD = "\x1bPqpayload\x1b\\";

function expectNoUnsafeTerminalControls(text: string) {
  expect(text).not.toContain(OSC52_CLIPBOARD);
  expect(text).not.toContain(CSI_CLEAR_SCREEN);
  expect(text).not.toContain(DCS_PAYLOAD);
  expect(text).not.toContain("\x07");
  expect(text).not.toContain("\r");
  expect(text).not.toContain("\b");
  expect(text).not.toContain("\x1b");
}

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

function createMaliciousDiffFile(): DiffFile {
  const payload = `${OSC52_CLIPBOARD}${CSI_CLEAR_SCREEN}${DCS_PAYLOAD}\x07\rspoof\bhidden\x1b`;
  const metadata = parseDiffFromFile(
    {
      name: `evil${payload}.ts`,
      contents: `export const answer = "before${payload}";\n`,
      cacheKey: "malicious-before",
    },
    {
      name: `evil${payload}.ts`,
      contents: `export const answer = "after${payload}";\n`,
      cacheKey: "malicious-after",
    },
    { context: 3 },
    true,
  );

  return {
    id: "malicious",
    path: `evil${payload}.ts`,
    patch: "",
    language: "typescript",
    stats: {
      additions: 1,
      deletions: 1,
    },
    metadata,
    agent: null,
  };
}

/** Build a small test diff with caller-controlled text and identity. */
function createTestDiffFile({
  after,
  before,
  id,
  path,
}: {
  after: string;
  before: string;
  id: string;
  path: string;
}): DiffFile {
  const metadata = parseDiffFromFile(
    { name: path, contents: before, cacheKey: `${id}-before` },
    { name: path, contents: after, cacheKey: `${id}-after` },
    { context: 3 },
    true,
  );

  return {
    id,
    path,
    patch: "",
    language: "text",
    stats: {
      additions: Math.max(0, after.split("\n").length - before.split("\n").length),
      deletions: Math.max(0, before.split("\n").length - after.split("\n").length),
    },
    metadata,
    agent: null,
  };
}

function createCjkDiffFile(): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: "i18n.ts",
      contents: "export const message = 'hello'; // greeting\n",
      cacheKey: "cjk-before",
    },
    {
      name: "i18n.ts",
      contents: "export const message = 'こんにちは'; // greeting\n",
      cacheKey: "cjk-after",
    },
    { context: 3 },
    true,
  );

  return {
    id: "i18n",
    path: "i18n.ts",
    patch: "",
    language: "typescript",
    stats: {
      additions: 1,
      deletions: 1,
    },
    metadata,
    agent: null,
  };
}

/** Build the copy context and measured stream for test files. */
function buildMultiFileTestContext({
  copyDecorations = true,
  files,
  layout = "stack",
  width = 120,
  wrapLines = false,
}: {
  copyDecorations?: boolean;
  files: DiffFile[];
  layout?: "stack" | "split";
  width?: number;
  wrapLines?: boolean;
}) {
  const theme = resolveTheme("github-dark-default", null);
  const sectionGeometry = files.map((file) =>
    measureDiffSectionGeometry(file, layout, true, theme, [], width, true, wrapLines),
  );
  const fileSectionLayouts = buildFileSectionLayouts(
    files,
    sectionGeometry.map((geometry) => geometry.bodyHeight),
  );
  const context: CopySelectionContext = {
    codeHorizontalOffset: 0,
    copyDecorations,
    files,
    fileSectionLayouts,
    headerLabelWidth: 60,
    headerStatsWidth: 12,
    layout,
    pinnedHeaderFile: files[0] ?? null,
    reserveAddNoteColumn: false,
    sectionGeometry,
    showHunkHeaders: true,
    showLineNumbers: true,
    width,
    wrapLines,
  };

  return { context, fileSectionLayouts, sectionGeometry };
}

/** Build a one-line change that sits on both split and stack add-note wrap boundaries. */
function createWrappedBoundaryDiffFile(): DiffFile {
  const metadata = parseDiffFromFile(
    { name: "boundary.ts", contents: "", cacheKey: "boundary-before" },
    { name: "boundary.ts", contents: "1234567\n", cacheKey: "boundary-after" },
    { context: 3 },
    true,
  );

  return {
    id: "boundary",
    path: "boundary.ts",
    patch: "",
    language: "typescript",
    stats: { additions: 1, deletions: 0 },
    metadata,
    agent: null,
  };
}

function buildContext(
  layout: "stack" | "split" = "stack",
  width = 120,
  file: DiffFile = createDiffFile(),
): {
  context: CopySelectionContext;
  fileSectionLayouts: ReturnType<typeof buildFileSectionLayouts>;
  sectionGeometry: ReturnType<typeof measureDiffSectionGeometry>[];
} {
  return buildMultiFileTestContext({ files: [file], layout, width });
}

/** Build copy and measured geometry with the same wrapped add-note reservation policy. */
function buildWrappedBoundaryContext(layout: "stack" | "split", reserveAddNoteColumn: boolean) {
  const file = createWrappedBoundaryDiffFile();
  const theme = resolveTheme("github-dark-default", null);
  const width = layout === "split" ? 20 : 10;
  const geometry = measureDiffSectionGeometry(
    file,
    layout,
    true,
    theme,
    [],
    width,
    false,
    true,
    new Set(),
    undefined,
    reserveAddNoteColumn,
  );
  const sectionGeometry = [geometry];
  const fileSectionLayouts = buildFileSectionLayouts([file], [geometry.bodyHeight]);
  const context: CopySelectionContext = {
    codeHorizontalOffset: 0,
    copyDecorations: true,
    files: [file],
    fileSectionLayouts,
    headerLabelWidth: 6,
    headerStatsWidth: 4,
    layout,
    pinnedHeaderFile: file,
    reserveAddNoteColumn,
    sectionGeometry,
    showHunkHeaders: true,
    showLineNumbers: false,
    width,
    wrapLines: true,
  };

  return { context, geometry, section: fileSectionLayouts[0]! };
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

describe("findLineCursorForClick", () => {
  test("resolves exact split sides and treats context rows as one cursor", () => {
    const file = createDiffFile();
    const { fileSectionLayouts, sectionGeometry } = buildContext("split", 120, file);
    const cursors = buildLineCursors([file], sectionGeometry);
    const oldCursor = cursors.find(
      (cursor) => cursor.target.side === "old" && cursor.target.line === 1,
    );
    const newCursor = cursors.find(
      (cursor) => cursor.target.side === "new" && cursor.target.line === 1,
    );
    const contextCursor = cursors.find((cursor) => cursor.target.line === 2);
    expect(oldCursor).toBeDefined();
    expect(newCursor).toBeDefined();
    expect(contextCursor).toBeDefined();

    const section = fileSectionLayouts[0]!;
    const changedBounds = sectionGeometry[0]!.rowBoundsByStableKey.get(oldCursor!.stableKey)!;
    const changedPoint: CopySelectionPoint = {
      kind: "review-row",
      column: 10,
      visualRow: section.bodyTop + changedBounds.top,
    };
    expect(
      findLineCursorForClick({
        cursors,
        fileSectionLayouts,
        point: changedPoint,
        sectionGeometry,
        side: "left",
      }),
    ).toBe(oldCursor!);
    expect(
      findLineCursorForClick({
        cursors,
        fileSectionLayouts,
        point: changedPoint,
        sectionGeometry,
        side: "right",
      }),
    ).toBe(newCursor!);

    const contextBounds = sectionGeometry[0]!.rowBoundsByStableKey.get(contextCursor!.stableKey)!;
    expect(
      findLineCursorForClick({
        cursors,
        fileSectionLayouts,
        point: {
          kind: "review-row",
          column: 10,
          visualRow: section.bodyTop + contextBounds.top,
        },
        sectionGeometry,
        side: "left",
      }),
    ).toBe(contextCursor!);
  });

  test("resolves a stacked row and ignores non-line rows", () => {
    const file = createDiffFile();
    const { fileSectionLayouts, sectionGeometry } = buildContext("stack", 120, file);
    const cursors = buildLineCursors([file], sectionGeometry);
    const cursor = cursors.find(
      (candidate) => candidate.target.side === "new" && candidate.target.line === 1,
    )!;
    const section = fileSectionLayouts[0]!;
    const bounds = sectionGeometry[0]!.rowBoundsByStableKey.get(cursor.stableKey)!;

    expect(
      findLineCursorForClick({
        cursors,
        fileSectionLayouts,
        point: {
          kind: "review-row",
          column: 10,
          visualRow: section.bodyTop + bounds.top,
        },
        sectionGeometry,
      }),
    ).toBe(cursor);
    expect(
      findLineCursorForClick({
        cursors,
        fileSectionLayouts,
        point: { kind: "review-row", column: 10, visualRow: section.bodyTop },
        sectionGeometry,
      }),
    ).toBeNull();
  });
});

describe("copySelectionDragIsClick", () => {
  const point = (column: number, visualRow: number): CopySelectionPoint => ({
    kind: "review-row",
    column,
    visualRow,
  });

  test("accepts one-cell mouse jitter around a click", () => {
    expect(
      copySelectionDragIsClick({
        anchor: point(20, 8),
        focus: point(21, 9),
        moved: true,
      }),
    ).toBe(true);
  });

  test("rejects deliberate drags and double-click expansion", () => {
    expect(
      copySelectionDragIsClick({
        anchor: point(20, 8),
        focus: point(22, 8),
        moved: true,
      }),
    ).toBe(false);
    expect(
      copySelectionDragIsClick({
        anchor: point(20, 8),
        focus: point(21, 8),
        moved: true,
        expanded: true,
      }),
    ).toBe(false);
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

  test("does not include terminal controls from copied paths or code", () => {
    const { context, fileSectionLayouts } = buildContext("stack", 160, createMaliciousDiffFile());
    const start: CopySelectionPoint = {
      kind: "pinned-header",
      column: 0,
      fileId: "malicious",
      nextVisualRow: fileSectionLayouts[0]!.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: context.width - 1,
      visualRow: fileSectionLayouts[0]!.sectionBottom - 1,
    };

    const text = renderCopySelectionText({ context, start, end });
    expect(text).toContain("evil");
    expect(text).toContain("before");
    expect(text).toContain("after");
    expectNoUnsafeTerminalControls(text);
  });

  test("clips wrapped code-only selections across partial first, middle, and last visual lines", () => {
    const sourceLine = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const file = createTestDiffFile({
      after: `${sourceLine}\n`,
      before: "",
      id: "wrapped",
      path: "wrapped.txt",
    });
    const { context, fileSectionLayouts, sectionGeometry } = buildMultiFileTestContext({
      copyDecorations: false,
      files: [file],
      width: 24,
      wrapLines: true,
    });
    const geometry = sectionGeometry[0]!;
    const rowIndex = geometry.plannedRows.findIndex(
      (row) =>
        row.kind === "diff-row" &&
        row.row.type === "stack-line" &&
        row.row.cell.kind === "addition",
    );
    const bounds = geometry.rowBounds[rowIndex]!;
    expect(bounds.height).toBeGreaterThan(2);

    const { gutterWidth, contentWidth } = resolveStackCellGeometry(
      context.width,
      geometry.lineNumberDigits,
      context.showLineNumbers,
      DIFF_RAIL_PREFIX_WIDTH,
    );
    const codeStart = DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    const chunks = Array.from({ length: Math.ceil(sourceLine.length / contentWidth) }, (_, index) =>
      sourceLine.slice(index * contentWidth, (index + 1) * contentWidth),
    );
    const rowTop = fileSectionLayouts[0]!.bodyTop + bounds.top;

    const text = renderCopySelectionText({
      context,
      start: { kind: "review-row", column: codeStart + 2, visualRow: rowTop },
      end: {
        kind: "review-row",
        column: codeStart + 4,
        visualRow: rowTop + bounds.height - 1,
      },
    });

    expect(text).toBe(
      [chunks[0]!.slice(2), ...chunks.slice(1, -1), chunks.at(-1)!.slice(0, 5)].join("\n"),
    );
  });

  test("omits blank source lines from code-only output", () => {
    const file = createTestDiffFile({
      after: "const first = 1;\n\nconst last = 2;\n",
      before: "const first = 1;\nconst last = 2;\n",
      id: "blank",
      path: "blank.ts",
    });
    const { context, fileSectionLayouts } = buildMultiFileTestContext({
      copyDecorations: false,
      files: [file],
    });
    const section = fileSectionLayouts[0]!;

    const text = renderCopySelectionText({
      context,
      start: { kind: "review-row", column: 0, visualRow: section.bodyTop },
      end: { kind: "review-row", column: context.width - 1, visualRow: section.sectionBottom - 1 },
    });

    expect(text).toBe("const first = 1;\nconst last = 2;");
    expect(text).not.toContain("\n\n");
  });

  test("retains an empty partial first line only in decorated output", () => {
    const { context, fileSectionLayouts } = buildContext();
    const section = fileSectionLayouts[0]!;
    const start: CopySelectionPoint = {
      kind: "review-row",
      column: context.width - 1,
      visualRow: section.bodyTop,
    };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: context.width - 1,
      visualRow: section.bodyTop + 1,
    };

    const decoratedText = renderCopySelectionText({ context, start, end });
    const codeOnlyText = renderCopySelectionText({
      context: { ...context, copyDecorations: false },
      start,
      end,
    });

    expect(decoratedText.startsWith("\n")).toBe(true);
    expect(codeOnlyText.startsWith("\n")).toBe(false);
    expect(codeOnlyText).toContain("export const answer = 41;");
  });

  test("clips an in-stream file header at the end of a multi-file selection", () => {
    const firstFile = createTestDiffFile({
      after: "first file after\n",
      before: "first file before\n",
      id: "first",
      path: "first.txt",
    });
    const secondFile = createTestDiffFile({
      after: "second file after\n",
      before: "second file before\n",
      id: "second",
      path: "second.txt",
    });
    const { context, fileSectionLayouts } = buildMultiFileTestContext({
      files: [firstFile, secondFile],
    });
    const firstSection = fileSectionLayouts[0]!;
    const secondSection = fileSectionLayouts[1]!;

    const text = renderCopySelectionText({
      context,
      start: {
        kind: "review-row",
        column: 0,
        visualRow: firstSection.sectionBottom - 1,
      },
      end: { kind: "review-row", column: 7, visualRow: secondSection.headerTop },
    });

    expect(text).toContain("first file after");
    expect(text.split("\n").at(-1)).toBe(" second.");
    expect(text).not.toContain("second file after");
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
  test("clips partial code-only text against the split right pane's global origin", () => {
    const { context, fileSectionLayouts, sectionGeometry } = buildContext("split");
    const geometry = sectionGeometry[0]!;
    const section = fileSectionLayouts[0]!;
    const rowIndex = geometry.plannedRows.findIndex(
      (row) => row.kind === "diff-row" && row.row.type === "split-line",
    );
    const visualRow = section.bodyTop + geometry.rowBounds[rowIndex]!.top;
    const { leftWidth } = resolveSplitPaneWidths(context.width);
    const { gutterWidth } = resolveSplitCellGeometry(
      context.width - leftWidth,
      geometry.lineNumberDigits,
      context.showLineNumbers,
      DIFF_RAIL_PREFIX_WIDTH,
    );
    const codeStart = leftWidth + DIFF_RAIL_PREFIX_WIDTH + gutterWidth;

    const text = renderCopySelectionText({
      context: { ...context, copyDecorations: false },
      start: { kind: "review-row", column: codeStart + 7, visualRow },
      end: { kind: "review-row", column: codeStart + 11, visualRow },
      side: "right",
    });

    expect(text).toBe("const");
  });

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

  const width = 80;
  const bodyTop = 10;
  const selectionStartRow = 15;
  const selectionEndRow = 20;

  /** Build one synthetic row range so interval boundary behavior stays explicit. */
  function selectedRangeForRow({
    pinnedStart = false,
    reverse = false,
    rowHeight,
    rowTop,
  }: {
    pinnedStart?: boolean;
    reverse?: boolean;
    rowHeight: number;
    rowTop: number;
  }) {
    const rowBounds = {
      key: "target-row",
      stableKey: "target-row",
      stableKeys: ["target-row"],
      top: rowTop,
      height: rowHeight,
    };
    const fileSectionLayouts = [
      {
        fileId: "example",
        sectionIndex: 0,
        sectionTop: bodyTop,
        headerTop: bodyTop,
        bodyTop,
        bodyHeight: 20,
        sectionBottom: bodyTop + 20,
      },
    ];
    const sectionGeometry = [
      {
        bodyHeight: 20,
        hunkAnchorRows: new Map(),
        hunkBounds: new Map(),
        lineNumberDigits: 1,
        plannedRows: [],
        rowBounds: [rowBounds],
        rowBoundsByKey: new Map([[rowBounds.key, rowBounds]]),
        rowBoundsByStableKey: new Map([[rowBounds.stableKey, rowBounds]]),
      },
    ];
    const start: CopySelectionPoint = pinnedStart
      ? {
          kind: "pinned-header",
          column: 11,
          fileId: "example",
          nextVisualRow: selectionStartRow,
        }
      : { kind: "review-row", column: 11, visualRow: selectionStartRow };
    const end: CopySelectionPoint = {
      kind: "review-row",
      column: 29,
      visualRow: selectionEndRow,
    };
    const drag: CopySelectionDrag = {
      anchor: reverse ? end : start,
      focus: reverse ? start : end,
      moved: true,
    };

    return buildCopySelectedRowKeys({ drag, fileSectionLayouts, sectionGeometry, width }).get(
      "example",
    );
  }

  for (const { name, reverse, rowHeight, rowTop, expected } of [
    {
      name: "clips an unwrapped row at the selection start column",
      rowTop: 5,
      rowHeight: 1,
      expected: { startCol: 11, endCol: width - 1 },
    },
    {
      name: "selects an unwrapped row inside the selection at full width",
      rowTop: 7,
      rowHeight: 1,
      expected: { startCol: 0, endCol: width - 1 },
    },
    {
      name: "clips an unwrapped row at the inclusive selection end column",
      rowTop: 10,
      rowHeight: 1,
      expected: { startCol: 0, endCol: 29 },
    },
    {
      name: "clips a wrapped row beginning before the selection",
      rowTop: 4,
      rowHeight: 3,
      expected: { startCol: 11, endCol: width - 1 },
    },
    {
      name: "clips a wrapped row ending after the selection",
      rowTop: 9,
      rowHeight: 3,
      expected: { startCol: 0, endCol: 29 },
    },
    {
      name: "clips a wrapped row spanning the selection during a reverse drag",
      rowTop: 4,
      rowHeight: 8,
      reverse: true,
      expected: { startCol: 11, endCol: 29 },
    },
    {
      name: "selects a wrapped row inside the selection at full width",
      rowTop: 7,
      rowHeight: 2,
      expected: { startCol: 0, endCol: width - 1 },
    },
  ] as const) {
    test(name, () => {
      const rows = selectedRangeForRow({ reverse, rowHeight, rowTop });
      expect([...rows!.entries()]).toEqual([["target-row", expected]]);
    });
  }

  test("keeps a reverse drag from the body to the pinned header on body-row boundaries", () => {
    const rows = selectedRangeForRow({
      pinnedStart: true,
      reverse: true,
      rowHeight: 1,
      rowTop: 5,
    });

    expect([...rows!.entries()]).toEqual([["target-row", { startCol: 11, endCol: width - 1 }]]);
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

describe("wrapped add-note copy parity", () => {
  for (const layout of ["split", "stack"] as const) {
    test(`${layout} continuation rows match measured, decorated, code-only, and word-selection boundaries`, () => {
      const unreserved = buildWrappedBoundaryContext(layout, false);
      const { context, geometry, section } = buildWrappedBoundaryContext(layout, true);
      const isAddedCodeRow = (row: (typeof geometry.plannedRows)[number]) =>
        row.kind === "diff-row" &&
        (row.row.type === "split-line"
          ? row.row.right.kind === "addition"
          : row.row.type === "stack-line" && row.row.cell.kind === "addition");
      const rowIndex = geometry.plannedRows.findIndex(isAddedCodeRow);
      const unreservedRowIndex = unreserved.geometry.plannedRows.findIndex(isAddedCodeRow);
      expect(rowIndex).toBeGreaterThanOrEqual(0);
      expect(unreservedRowIndex).toBeGreaterThanOrEqual(0);

      const row = geometry.plannedRows[rowIndex]!;
      const bounds = geometry.rowBounds[rowIndex]!;
      expect(unreserved.geometry.rowBounds[unreservedRowIndex]!.height).toBe(1);
      expect(bounds.height).toBe(2);

      const rowTop = section.bodyTop + bounds.top;
      const side: CopySelectionSide | undefined = layout === "split" ? "right" : undefined;
      const paneStart = layout === "split" ? resolveSplitPaneWidths(context.width).leftWidth : 0;
      const range = {
        start: { kind: "review-row" as const, column: paneStart, visualRow: rowTop },
        end: {
          kind: "review-row" as const,
          column: context.width - 1,
          visualRow: rowTop + bounds.height - 1,
        },
        side,
      };
      const decoratedLines = renderCopySelectionText({ context, ...range }).split("\n");
      const codeOnlyContext = { ...context, copyDecorations: false };
      const codeOnlyLines = renderCopySelectionText({
        context: codeOnlyContext,
        ...range,
      }).split("\n");
      expect(decoratedLines).toHaveLength(bounds.height);
      expect(codeOnlyLines).toEqual(["1234", "567"]);

      const plan = planCodeRowLayout(row, {
        width: context.width,
        lineNumberDigits: geometry.lineNumberDigits,
        reserveAddNoteColumn: context.reserveAddNoteColumn,
        showLineNumbers: context.showLineNumbers,
        wrapLines: context.wrapLines,
      })!;
      const cell = plan.kind === "split" ? plan.right : plan.cell;
      const codeStart = paneStart + cell.prefixWidth + cell.gutterWidth;
      const continuationPoint = {
        kind: "review-row" as const,
        column: codeStart,
        visualRow: rowTop + 1,
      };
      expect(expandSelectionPoint(continuationPoint, 2, codeOnlyContext)).toEqual({
        startCol: codeStart,
        endCol: codeStart + 2,
      });
      expect(
        renderCopySelectionText({
          context: codeOnlyContext,
          side,
          start: continuationPoint,
          end: { ...continuationPoint, column: codeStart + 2 },
        }),
      ).toBe("567");
    });
  }
});

describe("copy selection with wide (CJK) characters", () => {
  // "export const message = 'こんにちは" is 29 code units but 34 terminal cells: each full-width
  // character covers two cells, so cell columns and code-unit indices drift apart on this line.
  const cjkLine = "export const message = 'こんにちは'; // greeting";
  const throughWide = "export const message = 'こんにちは";

  function buildCjkContext() {
    const { context, fileSectionLayouts, sectionGeometry } = buildContext(
      "stack",
      120,
      createCjkDiffFile(),
    );
    const section = fileSectionLayouts[0]!;
    const geometry = sectionGeometry[0]!;
    const { gutterWidth } = resolveStackCellGeometry(
      context.width,
      geometry.lineNumberDigits,
      context.showLineNumbers,
      DIFF_RAIL_PREFIX_WIDTH,
    );
    const codeStart = DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    const codeOnlyContext: CopySelectionContext = { ...context, copyDecorations: false };

    // Locate the CJK addition row through full-width row copies so the tests do not
    // hard-code the planned-row layout.
    let visualRow = -1;
    for (let row = section.bodyTop; row < section.bodyTop + section.bodyHeight; row += 1) {
      const text = renderCopySelectionText({
        context: codeOnlyContext,
        start: { kind: "review-row", column: 0, visualRow: row },
        end: { kind: "review-row", column: context.width - 1, visualRow: row },
      });
      if (text.includes("こんにちは")) {
        visualRow = row;
        break;
      }
    }
    expect(visualRow).toBeGreaterThanOrEqual(0);

    return { context, codeOnlyContext, codeStart, visualRow };
  }

  test("code-only selection ending after the wide run copies exactly the selected cells", () => {
    const { codeOnlyContext, codeStart, visualRow } = buildCjkContext();

    const text = renderCopySelectionText({
      context: codeOnlyContext,
      start: { kind: "review-row", column: codeStart, visualRow },
      end: {
        kind: "review-row",
        column: codeStart + measureTextWidth(throughWide) - 1,
        visualRow,
      },
    });

    expect(text).toBe(throughWide);
  });

  test("code-only selection starting after the wide run copies exactly the selected cells", () => {
    const { codeOnlyContext, codeStart, visualRow } = buildCjkContext();

    const text = renderCopySelectionText({
      context: codeOnlyContext,
      start: {
        kind: "review-row",
        column: codeStart + measureTextWidth(throughWide),
        visualRow,
      },
      end: { kind: "review-row", column: codeOnlyContext.width - 1, visualRow },
    });

    expect(text).toBe("'; // greeting");
  });

  test("decorated selection ending after the wide run copies exactly the selected cells", () => {
    const { context, codeStart, visualRow } = buildCjkContext();

    const text = renderCopySelectionText({
      context,
      start: { kind: "review-row", column: codeStart, visualRow },
      end: {
        kind: "review-row",
        column: codeStart + measureTextWidth(throughWide) - 1,
        visualRow,
      },
    });

    expect(text).toBe(throughWide);
  });

  test("double-click on a word after the wide run selects the word measured in cells", () => {
    const { context, codeStart, visualRow } = buildCjkContext();
    const wordStartCell = measureTextWidth("export const message = 'こんにちは'; // ");
    const point: CopySelectionPoint = {
      kind: "review-row",
      // Click inside "greeting".
      column: codeStart + wordStartCell + 2,
      visualRow,
    };

    const result = expandSelectionPoint(point, 2, context);

    expect(result).toEqual({
      startCol: codeStart + wordStartCell,
      endCol: codeStart + wordStartCell + "greeting".length - 1,
    });
  });

  test("double-click on a wide character selects both of its terminal cells", () => {
    const { context, codeStart, visualRow } = buildCjkContext();
    // "ん" covers two cells; clicking the second cell must still select the whole character.
    const wideCharStartCell = measureTextWidth("export const message = 'こ");
    const point: CopySelectionPoint = {
      kind: "review-row",
      column: codeStart + wideCharStartCell + 1,
      visualRow,
    };

    const result = expandSelectionPoint(point, 2, context);

    expect(result).toEqual({
      startCol: codeStart + wideCharStartCell,
      endCol: codeStart + wideCharStartCell + 1,
    });
  });

  test("code-only triple-click covers the full cell width of the line", () => {
    const { codeOnlyContext, codeStart, visualRow } = buildCjkContext();
    const point: CopySelectionPoint = {
      kind: "review-row",
      column: codeStart + 2,
      visualRow,
    };

    const result = expandSelectionPoint(point, 3, codeOnlyContext);

    expect(result).toEqual({
      startCol: codeStart,
      endCol: codeStart + measureTextWidth(cjkLine) - 1,
    });
  });

  test("pinned-header selection stays cell-aligned for wide-character filenames", () => {
    const metadata = parseDiffFromFile(
      { name: "日本語.ts", contents: "export const a = 1;\n", cacheKey: "cjk-path-before" },
      { name: "日本語.ts", contents: "export const a = 2;\n", cacheKey: "cjk-path-after" },
      { context: 3 },
      true,
    );
    const file: DiffFile = {
      id: "cjk-path",
      path: "日本語.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 1, deletions: 1 },
      metadata,
      agent: null,
    };
    const { context, fileSectionLayouts } = buildContext("stack", 120, file);
    const nextVisualRow = fileSectionLayouts[0]!.bodyTop;

    const headerCells = (startColumn: number, endColumn: number) =>
      renderCopySelectionText({
        context,
        start: { kind: "pinned-header", column: startColumn, fileId: "cjk-path", nextVisualRow },
        end: { kind: "pinned-header", column: endColumn, fileId: "cjk-path", nextVisualRow },
      });

    // The label starts after one padding cell: "日本語.ts" spans cells 1..9.
    expect(headerCells(1, 9)).toBe("日本語.ts");

    // DiffFileHeaderRow right-aligns the stats, so "-1" ends at cell width - 3 (one trailing
    // stats space plus one padding cell). A code-unit gap would shift these cells onto "+1".
    expect(headerCells(context.width - 4, context.width - 3)).toBe("-1");
  });
});

describe("copy selection with zero-width characters", () => {
  test("selection starting at a zero-width boundary keeps the invisible character", () => {
    // A mid-line U+200B survives rendering (only leading zero-width clusters are dropped by
    // sliceTextByWidth), so copying must round-trip it for the invisible bug to stay visible
    // in the pasted text.
    const metadata = parseDiffFromFile(
      { name: "zero.ts", contents: "const x = 1;\n", cacheKey: "zero-before" },
      {
        name: "zero.ts",
        contents: "const x = 1;\nconst zw = 'a\u200bb';\n",
        cacheKey: "zero-after",
      },
      { context: 3 },
      true,
    );
    const file: DiffFile = {
      id: "zero",
      path: "zero.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 1, deletions: 0 },
      metadata,
      agent: null,
    };
    const { context, fileSectionLayouts, sectionGeometry } = buildContext("stack", 120, file);
    const section = fileSectionLayouts[0]!;
    const geometry = sectionGeometry[0]!;
    const { gutterWidth } = resolveStackCellGeometry(
      context.width,
      geometry.lineNumberDigits,
      context.showLineNumbers,
      DIFF_RAIL_PREFIX_WIDTH,
    );
    const codeStart = DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    const codeOnlyContext: CopySelectionContext = { ...context, copyDecorations: false };

    let visualRow = -1;
    for (let row = section.bodyTop; row < section.bodyTop + section.bodyHeight; row += 1) {
      const text = renderCopySelectionText({
        context: codeOnlyContext,
        start: { kind: "review-row", column: 0, visualRow: row },
        end: { kind: "review-row", column: context.width - 1, visualRow: row },
      });
      if (text.includes("zw")) {
        visualRow = row;
        break;
      }
    }
    expect(visualRow).toBeGreaterThanOrEqual(0);

    // "const zw = 'a" is 13 cells; the zero-width character sits at that boundary before "b".
    const text = renderCopySelectionText({
      context: codeOnlyContext,
      start: { kind: "review-row", column: codeStart + 13, visualRow },
      end: { kind: "review-row", column: codeOnlyContext.width - 1, visualRow },
    });

    expect(text).toBe("\u200bb';");
  });
});
