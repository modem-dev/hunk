import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { capturedTestColorToHex } from "../../../../../test/helpers/test-color-helpers";
import { contrastRatio } from "../lib/color";
import {
  cursorLineHighlightBg,
  lineHighlightToneStyle,
  selectionHighlightBg,
  stackCellPalette,
} from "./rowStyle";
import { legacyPlannedDiffRow, planCodeRowLayout } from "./codeRowLayout";
import type { DiffRow } from "./diffRows";
import { lineHighlightPaintKey, type LineHighlightPaintIndex } from "./lineHighlightPaint";
import { DiffRowView } from "./DiffRowView";
import { resolveTheme, withTransparentSurfaces } from "../themes";

/** Capture one code-row component and always release its OpenTUI renderer. */
async function captureCodeRow(node: ReactNode, width = 40, height = 4) {
  const setup = await testRender(node, { width, height });
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    return {
      frame: setup.captureCharFrame(),
      spans: setup.captureSpans(),
    };
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

/** Return normalized colors from the first captured span carrying text. */
function colorsForText(capture: Awaited<ReturnType<typeof captureCodeRow>>["spans"], text: string) {
  const span = capture.lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  return {
    fg: capturedTestColorToHex(span?.fg)?.toLowerCase(),
    bg: capturedTestColorToHex(span?.bg)?.toLowerCase(),
  };
}

/** Return the normalized background of the first captured span carrying text. */
function backgroundForText(
  capture: Awaited<ReturnType<typeof captureCodeRow>>["spans"],
  text: string,
) {
  return colorsForText(capture, text).bg;
}

const stackRow: Extract<DiffRow, { type: "stack-line" }> = {
  type: "stack-line",
  key: "paint:stack",
  fileId: "paint",
  hunkIndex: 0,
  cell: {
    kind: "addition",
    sign: "+",
    newLineNumber: 1,
    spans: [{ text: "abcd" }],
  },
};

/** Render common DiffRowView props while varying paint-sensitive inputs. */
function codeRowView(row: DiffRow, options: Partial<Parameters<typeof DiffRowView>[0]> = {}) {
  const theme = options.theme ?? resolveTheme("github-dark-default", null);
  return (
    <DiffRowView
      row={row}
      width={12}
      lineNumberDigits={1}
      showLineNumbers={false}
      showHunkHeaders={true}
      wrapLines={false}
      codeHorizontalOffset={0}
      theme={theme}
      selected={false}
      {...options}
    />
  );
}

describe("CodeCellView painting", () => {
  test("keeps partial copy selections exact in nowrap and wrapped stack cells", async () => {
    const theme = resolveTheme("github-dark-default", null);

    for (const wrapLines of [false, true]) {
      const plannedRow = legacyPlannedDiffRow(stackRow);
      const layout = planCodeRowLayout(plannedRow, {
        width: 12,
        lineNumberDigits: 1,
        showLineNumbers: false,
        wrapLines,
      });
      if (!layout || layout.kind !== "stack") throw new Error("Expected stack layout");
      const contentStart = layout.cell.prefixWidth + layout.cell.gutterWidth;
      const capture = await captureCodeRow(
        codeRowView(stackRow, {
          copySelectedRowRange: {
            startCol: contentStart + 1,
            endCol: contentStart + 2,
          },
          wrapLines,
        }),
      );

      expect(backgroundForText(capture.spans, "bc")).toBe(
        selectionHighlightBg(stackCellPalette("addition", theme).contentBg, theme).toLowerCase(),
      );
      expect(capture.frame).toContain("abcd");
    }
  });

  test("keeps extension highlights geometry-neutral for wide and combining text", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const row: Extract<DiffRow, { type: "stack-line" }> = {
      ...stackRow,
      key: "paint:wide",
      cell: {
        ...stackRow.cell,
        spans: [{ text: "a\u0301日bc" }],
      },
    };
    const lineHighlights: LineHighlightPaintIndex = new Map([
      [lineHighlightPaintKey("new", 1), [{ startCol: 1, endCol: 3, tone: "match" }]],
    ]);

    for (const wrapLines of [false, true]) {
      const plain = await captureCodeRow(codeRowView(row, { width: 7, wrapLines }));
      const marked = await captureCodeRow(
        codeRowView(row, { width: 7, wrapLines, lineHighlights }),
      );

      expect(marked.frame).toBe(plain.frame);
      expect(backgroundForText(marked.spans, "\u0301")).toBe(
        lineHighlightToneStyle(
          "match",
          stackCellPalette("addition", theme).contentBg,
          theme,
        )!.bg.toLowerCase(),
      );
    }
  });

  test("resolves dim foregrounds against the final cursor background", async () => {
    const theme = resolveTheme("ayu-light", null);
    const row: Extract<DiffRow, { type: "stack-line" }> = {
      ...stackRow,
      key: "paint:dim-cursor",
      cell: {
        ...stackRow.cell,
        spans: [{ text: "dimtext", fg: theme.syntaxColors.default }],
      },
    };
    const lineHighlights: LineHighlightPaintIndex = new Map([
      [lineHighlightPaintKey("new", 1), [{ startCol: 0, endCol: 7, tone: "dim" }]],
    ]);

    for (const wrapLines of [false, true]) {
      const capture = await captureCodeRow(
        codeRowView(row, {
          cursorHighlight: { stableKey: row.key, side: "new", style: "row" },
          lineHighlights,
          theme,
          wrapLines,
        }),
      );
      const colors = colorsForText(capture.spans, "dimtext");

      expect(colors.fg).toBeDefined();
      expect(colors.bg).toBeDefined();
      expect(contrastRatio(colors.fg!, colors.bg!)).toBeGreaterThanOrEqual(1.6);
    }
  });

  test("resolves selected and unselected pieces of one dim span against their own backgrounds", async () => {
    const theme = resolveTheme("ayu-light", null);
    const row: Extract<DiffRow, { type: "stack-line" }> = {
      ...stackRow,
      key: "paint:dim-copy-selection",
      cell: {
        ...stackRow.cell,
        spans: [{ text: "dimtext", fg: theme.syntaxColors.default }],
      },
    };
    const lineHighlights: LineHighlightPaintIndex = new Map([
      [lineHighlightPaintKey("new", 1), [{ startCol: 0, endCol: 7, tone: "dim" }]],
    ]);

    for (const wrapLines of [false, true]) {
      const plannedRow = legacyPlannedDiffRow(row);
      const layout = planCodeRowLayout(plannedRow, {
        width: 12,
        lineNumberDigits: 1,
        showLineNumbers: false,
        wrapLines,
      });
      if (!layout || layout.kind !== "stack") throw new Error("Expected stack layout");
      const contentStart = layout.cell.prefixWidth + layout.cell.gutterWidth;
      const capture = await captureCodeRow(
        codeRowView(row, {
          copySelectedRowRange: {
            startCol: contentStart + 1,
            endCol: contentStart + 3,
          },
          lineHighlights,
          theme,
          wrapLines,
        }),
      );
      const ordinary = colorsForText(capture.spans, "d");
      const selected = colorsForText(capture.spans, "im");

      expect(ordinary.fg).toBeDefined();
      expect(ordinary.bg).toBeDefined();
      expect(selected.fg).toBeDefined();
      expect(selected.bg).toBeDefined();
      expect(contrastRatio(ordinary.fg!, ordinary.bg!)).toBeGreaterThanOrEqual(1.6);
      expect(contrastRatio(selected.fg!, selected.bg!)).toBeGreaterThanOrEqual(1.6);
      expect(selected.bg).not.toBe(ordinary.bg);
      expect(selected.fg).not.toBe(ordinary.fg);
    }
  });

  test("paints transparent-theme cursors while retaining split and stack note guides", async () => {
    const theme = withTransparentSurfaces(resolveTheme("github-dark-default", null));
    const rows: DiffRow[] = [
      {
        type: "split-line",
        key: "paint:split-context",
        fileId: "paint",
        hunkIndex: 0,
        left: { kind: "context", sign: " ", lineNumber: 1, spans: [{ text: "shared" }] },
        right: { kind: "context", sign: " ", lineNumber: 1, spans: [{ text: "shared" }] },
      },
      {
        type: "stack-line",
        key: "paint:stack-context",
        fileId: "paint",
        hunkIndex: 0,
        cell: {
          kind: "context",
          sign: " ",
          oldLineNumber: 1,
          newLineNumber: 1,
          spans: [{ text: "shared" }],
        },
      },
    ];

    for (const row of rows) {
      for (const wrapLines of [false, true]) {
        const capture = await captureCodeRow(
          codeRowView(row, {
            cursorHighlight: { stableKey: row.key, side: "new", style: "row" },
            noteGuideSide: "new",
            theme,
            width: row.type === "split-line" ? 24 : 12,
            wrapLines,
          }),
        );

        expect(capture.frame).toContain("│");
        expect(backgroundForText(capture.spans, "shared")).toBe(
          cursorLineHighlightBg(stackCellPalette("context", theme).contentBg, theme).toLowerCase(),
        );
      }
    }
  });
});
