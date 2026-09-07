import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../../../../../../test/helpers/test-color-helpers";
import type { ExtensionPaneProps } from "../../../../extension-api/types";
import { toExtensionPaintTheme } from "../../../../ui/lib/extensionPaintTheme";
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
  test("separates review chrome with the diff's thin accent rail and panel background", async () => {
    const appTheme = resolveTheme("github-dark-default", null);
    const theme = toExtensionPaintTheme(appTheme);
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
        theme.panel.toLowerCase(),
        theme.panel.toLowerCase(),
      ]);
      for (const line of setup.captureSpans().lines.slice(1, 3)) {
        const rail = line.spans.find((span) => span.text === "▌");
        expect(capturedTestColorToHex(rail?.fg)).toBe(theme.accent.toLowerCase());
      }
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

  test("renders commit metadata with the same panel chrome and copies its full revision", async () => {
    const fullRevision = "0123456789abcdef0123456789abcdef01234567";
    const appTheme = resolveTheme("github-dark-default", null);
    const theme = toExtensionPaintTheme(appTheme);
    const width = 60;
    const copyText = mock(() => true);
    const setup = await testRender(
      <ReviewInfoPane
        {...({
          actions: { copyText } as unknown as ExtensionPaneProps["actions"],
          review: {
            kind: "commit",
            provider: "GitHub",
            title: "Render selected commit metadata",
            revision: fullRevision,
            author: "octocat",
            authoredAt: new Date(Date.now() - 10 * 60 * 60 * 1_000).toISOString(),
          },
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
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Render selected commit metadata");
      expect(frame).toContain("octocat · 10 hours ago");
      expect(frame.split("\n")[1]?.trimEnd()).toEndWith("0123456789abcdef01… ⧉");
      expect(frame).not.toContain("GitHub");
      const revisionSpan = setup
        .captureSpans()
        .lines[1]?.spans.find((span) => span.text.includes("0123456789abcdef01…"));
      expect(capturedTestColorToHex(revisionSpan?.fg)).toBe(theme.fileRenamed.toLowerCase());
      const copySpan = setup.captureSpans().lines[1]?.spans.find((span) => span.text === "⧉");
      expect(capturedTestColorToHex(copySpan?.fg)).toBe(appTheme.lineNumberFg.toLowerCase());
      await act(async () => setup.mockMouse.click(width - 2, 1));
      expect(copyText).toHaveBeenCalledWith(fullRevision);
      expect(backgroundsAtColumn(setup, 0).slice(1)).toEqual([
        theme.panel.toLowerCase(),
        theme.panel.toLowerCase(),
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("renders comparison commits as tight rows with reusable copy actions", async () => {
    const theme = toExtensionPaintTheme(resolveTheme("github-dark-default", null));
    const copyText = mock(() => true);
    const commits = [
      {
        title: "Keep comparison metadata visible",
        author: "Ada",
        authoredAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
        revision: "a9c17e2f00000000000000000000000000000000",
        displayRevision: "a9c17e2f",
      },
      {
        title: "Review contiguous commit ranges",
        author: "Ben",
        authoredAt: new Date(Date.now() - 5 * 60 * 60 * 1_000).toISOString(),
        revision: "ff97b44200000000000000000000000000000000",
        displayRevision: "ff97b442",
      },
    ];
    const width = 80;
    const setup = await testRender(
      <ReviewInfoPane
        {...({
          actions: { copyText } as unknown as ExtensionPaneProps["actions"],
          review: {
            kind: "comparison",
            provider: "Git",
            title: "2 commits",
            base: "base1234",
            head: "head5678",
            commitCount: 2,
            commits,
          },
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
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Keep comparison metadata visible");
      expect(frame).toContain("Ada · 2 hours ago");
      expect(frame).toContain("a9c17e2f ⧉");
      expect(frame).toContain("Review contiguous commit ranges");
      expect(frame).toContain("Ben · 5 hours ago");
      expect(frame).toContain("ff97b442 ⧉");
      await act(async () => setup.mockMouse.click(width - 2, 1));
      expect(copyText).toHaveBeenCalledWith(commits[0]!.revision);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("keeps the border deterministic when no metadata text fits", async () => {
    const theme = toExtensionPaintTheme(resolveTheme("github-dark-default", null));
    const setup = await testRender(
      <ReviewInfoPane
        {...({
          review,
          width: 3,
          height: 3,
          theme,
        } as unknown as ExtensionPaneProps)}
      />,
      { width: 3, height: 3 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      expect(setup.captureCharFrame().split("\n").slice(0, 3)).toEqual(["───", "▌  ", "▌  "]);
    } finally {
      setup.renderer.destroy();
    }
  });
});
