import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../../test/helpers/test-color-helpers";
import { resolveTheme } from "../themes";
import { CodeRowView, type PlannedCodeReviewRow } from "./CodeRowView";
import {
  cursorLineHighlightBg,
  selectionHighlightBg,
  stackCellPalette,
  stackRailColor,
} from "./rowStyle";

/** Return the normalized background painted behind matching captured text. */
function backgroundForText(
  capture: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
  text: string,
) {
  const span = capture.lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  return capturedTestColorToHex(span?.bg)?.toLowerCase();
}

/** Return the normalized foreground of the first captured span carrying text. */
function foregroundForText(
  capture: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
  text: string,
) {
  const span = capture.lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  return capturedTestColorToHex(span?.fg)?.toLowerCase();
}

test("CodeRowView limits character selections to source text instead of cell chrome", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:character-range",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    row: {
      type: "stack-line",
      key: "character-range",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "addition",
        sign: "+",
        newLineNumber: 1,
        spans: [{ text: "selected" }],
      },
    },
  };
  const setup = await testRender(
    <CodeRowView
      plannedRow={plannedRow}
      width={16}
      lineNumberDigits={1}
      showLineNumbers={false}
      wrapLines={false}
      codeHorizontalOffset={0}
      theme={theme}
      selected={false}
      copySelectedRowRange={{ startCol: 5, endCol: 7 }}
    />,
    { width: 20, height: 2 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const spans = setup.captureSpans();
    const palette = stackCellPalette("addition", theme);

    expect(backgroundForText(spans, "lec")).toBe(
      selectionHighlightBg(palette.contentBg, theme).toLowerCase(),
    );
    expect(backgroundForText(spans, "se")).toBe(palette.contentBg.toLowerCase());
    expect(backgroundForText(spans, "+ ")).toBe(palette.gutterBg.toLowerCase());
    expect(backgroundForText(spans, "▌")).toBe(theme.panel.toLowerCase());
    expect(foregroundForText(spans, "+ ")).toBe(palette.numberColor.toLowerCase());
    expect(foregroundForText(spans, "▌")).toBe(
      stackRailColor("addition", theme, false).toLowerCase(),
    );
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("CodeRowView gives copy selection precedence over cursor paint", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:precedence",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    row: {
      type: "stack-line",
      key: "precedence",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "addition",
        sign: "+",
        newLineNumber: 1,
        spans: [{ text: "selected" }],
      },
    },
  };
  const setup = await testRender(
    <CodeRowView
      plannedRow={plannedRow}
      width={16}
      lineNumberDigits={1}
      showLineNumbers={false}
      wrapLines={false}
      codeHorizontalOffset={0}
      theme={theme}
      selected={false}
      copySelectedRowRange={{ startCol: 0, endCol: Number.MAX_SAFE_INTEGER }}
      cursorHighlight={{ stableKey: plannedRow.stableKey, side: "new", style: "row" }}
    />,
    { width: 20, height: 2 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const background = backgroundForText(setup.captureSpans(), "selected");
    const baseBackground = stackCellPalette("addition", theme).contentBg;

    expect(background).toBe(selectionHighlightBg(baseBackground, theme).toLowerCase());
    expect(background).not.toBe(cursorLineHighlightBg(baseBackground, theme).toLowerCase());
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("CodeRowView overlays the nowrap add-note badge instead of shifting the note guide", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:note-guide-hover",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    anchorId: "note-guide",
    noteGuideSide: "new",
    row: {
      type: "stack-line",
      key: "note-guide-hover",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "addition",
        sign: "+",
        newLineNumber: 1,
        spans: [{ text: "selected" }],
      },
    },
  };
  const setup = await testRender(
    <CodeRowView
      plannedRow={plannedRow}
      width={16}
      lineNumberDigits={1}
      showLineNumbers={false}
      wrapLines={false}
      codeHorizontalOffset={0}
      theme={theme}
      selected={false}
      showAddNoteBadge
      onStartUserNoteAtHunk={() => {}}
    />,
    { width: 17, height: 2 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const line = setup.captureCharFrame().split("\n")[0] ?? "";

    expect(line.slice(0, 16)).toEndWith("[+]");
    expect(line.slice(0, 16)).not.toContain("│[+]");
    expect(line[16]).toBe("│");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
