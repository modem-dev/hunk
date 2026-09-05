import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../../../test/helpers/test-color-helpers";
import { resolveTheme } from "../../themes";
import { PaneDivider } from "./PaneDivider";

const theme = resolveTheme("github-dark-default", null);
const noop = () => {};

/** Render one divider and capture both its cells and paint spans. */
async function captureDivider(isActive: boolean) {
  const setup = await testRender(
    <PaneDivider
      orientation="horizontal"
      width={8}
      height={1}
      isActive={isActive}
      isResizing={false}
      resizable={false}
      theme={theme}
      onMouseDown={noop}
      onMouseDrag={noop}
      onMouseDragEnd={noop}
      onMouseUp={noop}
    />,
    { width: 8, height: 1 },
  );
  try {
    await act(async () => setup.renderOnce());
    return { frame: setup.captureCharFrame(), spans: setup.captureSpans() };
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}

describe("PaneDivider", () => {
  test("changes weight and semantic color when its pane is active", async () => {
    const inactive = await captureDivider(false);
    const active = await captureDivider(true);
    const inactiveSpan = inactive.spans.lines.flatMap((line) => line.spans)[0];
    const activeSpan = active.spans.lines.flatMap((line) => line.spans)[0];

    expect(inactive.frame).toContain("────────");
    expect(active.frame).toContain("━━━━━━━━");
    expect(capturedTestColorToHex(inactiveSpan?.fg)?.toLowerCase()).toBe(
      theme.border.toLowerCase(),
    );
    expect(capturedTestColorToHex(activeSpan?.fg)?.toLowerCase()).toBe(theme.accent.toLowerCase());
  });
});
