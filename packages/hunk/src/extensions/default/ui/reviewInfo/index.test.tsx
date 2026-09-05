import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../../../../../../test/helpers/test-color-helpers";
import type { ExtensionPaneProps } from "../../../../extension-api/types";
import { resolveTheme } from "../../../../ui/themes";
import { ReviewInfoPane } from ".";
import { reviewInfoLines } from "./presentation";

const review = {
  kind: "change-request" as const,
  provider: "GitHub",
  title: "A deliberately long delegated review title",
  id: "#123",
  repository: "modem-dev/hunk",
  author: "octocat",
  base: "main",
  head: "feature/review-info",
  state: "open" as const,
};

/** Return the background painted at one terminal column on every captured row. */
function backgroundsAtColumn(
  setup: Awaited<ReturnType<typeof testRender>>,
  column: number,
): Array<string | null> {
  return setup.captureSpans().lines.map((line) => {
    let spanStart = 0;
    for (const span of line.spans) {
      const spanEnd = spanStart + span.width;
      if (spanStart <= column && column < spanEnd) return capturedTestColorToHex(span.bg);
      spanStart = spanEnd;
    }
    return null;
  });
}

describe("ReviewInfoPane", () => {
  test("separates review chrome with an accent rail and panel background", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const width = 30;
    const setup = await testRender(
      <ReviewInfoPane
        {...({
          review,
          width,
          height: 3,
          theme,
        } as unknown as ExtensionPaneProps)}
      />,
      { width, height: 3 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      expect(backgroundsAtColumn(setup, 0)).toEqual([
        theme.panel.toLowerCase(),
        theme.accent.toLowerCase(),
        theme.accent.toLowerCase(),
      ]);
      expect(backgroundsAtColumn(setup, 1)).toEqual([
        theme.panel.toLowerCase(),
        theme.panel.toLowerCase(),
        theme.panel.toLowerCase(),
      ]);
      expect(backgroundsAtColumn(setup, width - 1)).toEqual([
        theme.panel.toLowerCase(),
        theme.panel.toLowerCase(),
        theme.panel.toLowerCase(),
      ]);
      expect(backgroundsAtColumn(setup, 1)).not.toContain(theme.panelAlt.toLowerCase());

      const [primary, secondary] = reviewInfoLines(review, width - 3);
      const frame = setup.captureCharFrame();
      expect(frame.split("\n")[0]).toBe("─".repeat(width));
      const borderSpan = setup.captureSpans().lines[0]?.spans.find((span) => span.width > 0);
      expect(capturedTestColorToHex(borderSpan?.fg)).toBe(theme.border.toLowerCase());
      expect(frame).toContain(` ${primary}`);
      expect(frame).toContain(` ${secondary}`);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("keeps the border deterministic when no metadata text fits", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const setup = await testRender(
      <ReviewInfoPane
        {...({
          review,
          width: 1,
          height: 3,
          theme,
        } as unknown as ExtensionPaneProps)}
      />,
      { width: 1, height: 3 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      expect(setup.captureCharFrame().split("\n").slice(0, 3)).toEqual(["─", " ", " "]);
    } finally {
      setup.renderer.destroy();
    }
  });
});
