import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { resolveTheme } from "../../themes";

const { OverviewDialog } = await import("./OverviewDialog");

async function captureFrame(node: ReactNode, width = 120, height = 24) {
  const setup = await testRender(node, { width, height });

  try {
    await act(async () => {
      await setup.renderOnce();
    });

    return setup.captureCharFrame();
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

describe("OverviewDialog", () => {
  const theme = resolveTheme("github-dark-default", null);
  const baseProps = {
    terminalHeight: 30,
    terminalWidth: 100,
    theme,
    onClose: () => {},
  };

  test("renders the title and description body text", async () => {
    const frame = await captureFrame(
      <OverviewDialog {...baseProps} title="PR title" description={"# Heading\n\nbody text"} />,
      100,
      30,
    );

    expect(frame).toContain("Overview");
    expect(frame).toContain("PR title");
    expect(frame).toContain("Heading");
    expect(frame).toContain("body text");
  });

  test("differentiates heading levels with markdown hash prefixes", async () => {
    const frame = await captureFrame(
      <OverviewDialog {...baseProps} description={"# Top\n\n### Deep"} />,
      100,
      30,
    );

    expect(frame).toContain("# Top");
    expect(frame).toContain("### Deep");
  });

  test("renders body without a title, no crash", async () => {
    const frame = await captureFrame(
      <OverviewDialog {...baseProps} description={"# Heading\n\nbody text"} />,
      100,
      30,
    );

    expect(frame).toContain("Heading");
    expect(frame).toContain("body text");
  });

  test("falls back to the legacy summary as the body when no description is given", async () => {
    const frame = await captureFrame(
      <OverviewDialog {...baseProps} title="PR title" summary="legacy summary body" />,
      100,
      30,
    );

    expect(frame).toContain("PR title");
    expect(frame).toContain("legacy summary body");
  });

  test("prefers description over summary when both are present", async () => {
    const frame = await captureFrame(
      <OverviewDialog {...baseProps} description="chosen description" summary="ignored summary" />,
      100,
      30,
    );

    expect(frame).toContain("chosen description");
    expect(frame).not.toContain("ignored summary");
  });

  test("wraps a long multi-span bullet without garbling its words", async () => {
    // Regression: long list items full of inline `code`/**bold** spans used to
    // overlap because every span was fit to the full width and laid side by side.
    const description =
      "- **Markdown engine** — `markdownRows.ts` turns markdown into themeable rows using the `marked` lexer, then blockquotes and links all render correctly.";
    // Render surface and the dialog's terminalWidth must match, or the dialog is
    // clipped and a right-edge word is cut off — which is not what this guards.
    const frame = await captureFrame(
      <OverviewDialog {...baseProps} terminalWidth={80} description={description} />,
      80,
      30,
    );

    // Each distinct word must survive intact (not merged/overlapped with another).
    for (const word of [
      "Markdown",
      "engine",
      "markdownRows.ts",
      "themeable",
      "marked",
      "blockquotes",
      "links",
    ]) {
      expect(frame).toContain(word);
    }
    // The bullet marker is present and the garbled merge from the bug is gone.
    expect(frame).toContain("•");
    expect(frame).not.toContain("themeablemarked");
    // Spaces at span boundaries (plain text -> inline `code`) must be preserved.
    expect(frame).toContain("using the marked");
  });

  test("renders empty state when neither title nor description provided, no crash", async () => {
    const frame = await captureFrame(<OverviewDialog {...baseProps} />, 100, 30);

    expect(frame).toContain("No description provided.");
  });
});
