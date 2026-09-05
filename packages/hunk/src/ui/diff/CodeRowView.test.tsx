import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../../../../test/helpers/test-color-helpers";
import { resolveTheme } from "../themes";
import { CodeRowView, type PlannedCodeReviewRow } from "./CodeRowView";
import { cursorLineHighlightBg, selectionHighlightBg, stackCellPalette } from "./rowStyle";

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
