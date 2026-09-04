import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { resolveTheme } from "../themes";
import { ParentSelectorDialog } from "./ParentSelectorDialog";

describe("ParentSelectorDialog", () => {
  test("uses every available body row and moves the window with the mouse wheel", async () => {
    const selected: number[] = [];
    const setup = await testRender(
      <ParentSelectorDialog
        parentRevisionIds={["parent-1", "parent-2", "parent-3", "parent-4"]}
        selectedIndex={0}
        terminalHeight={10}
        terminalWidth={40}
        theme={resolveTheme("github-dark-default", null)}
        onAccept={() => {}}
        onClose={() => {}}
        onSelect={(index) => selected.push(index)}
      />,
      { width: 40, height: 10 },
    );
    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("parent-1");
      expect(frame).toContain("parent-2");

      await act(async () => {
        await setup.mockMouse.scroll(20, 5, "down");
        await setup.renderOnce();
      });
      expect(selected).toEqual([1]);
    } finally {
      setup.renderer.destroy();
    }
  });
});
