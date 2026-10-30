import { describe, expect, mock, test } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { resolveTheme } from "../../themes";
import { SelectionActionBar } from "./SelectionActionBar";

/** Capture the leaf action bar and release its OpenTUI renderer. */
async function captureSelectionActionBar(
  bounds: Parameters<typeof SelectionActionBar>[0]["model"]["bounds"],
) {
  const setup = await testRender(
    <SelectionActionBar
      model={{
        bounds,
        commentEnabled: false,
        commentLabel: "Ctrl+N Comment",
        copyLabel: "Ctrl+X Copy",
      }}
      onClear={() => {}}
      onComment={() => {}}
      onCopy={() => {}}
      onPointerActionStart={() => {}}
      theme={resolveTheme("github-dark-default", null)}
    />,
    { width: 60, height: 10 },
  );
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

describe("SelectionActionBar", () => {
  test("renders planned configurable labels and disabled reason rows", async () => {
    const frame = await captureSelectionActionBar({
      top: 0,
      left: 0,
      width: 45,
      height: 4,
      compact: false,
      reasonLines: ["Comment requires contiguous code"],
    });

    expect(frame).toContain("Ctrl+N Comment");
    expect(frame).toContain("Ctrl+X Copy");
    expect(frame).toContain("Esc Clear");
    expect(frame).toContain("Comment requires contiguous code");
  });

  test("uses the planner's compact vertical action layout", async () => {
    const frame = await captureSelectionActionBar({
      top: 0,
      left: 0,
      width: 20,
      height: 5,
      compact: true,
    });
    const rows = frame.split("\n");

    expect(rows.findIndex((row) => row.includes("Ctrl+N Comment"))).toBeLessThan(
      rows.findIndex((row) => row.includes("Ctrl+X Copy")),
    );
    expect(rows.findIndex((row) => row.includes("Ctrl+X Copy"))).toBeLessThan(
      rows.findIndex((row) => row.includes("Esc Clear")),
    );
  });

  test("routes pointer actions without leaving native selection or bubbling mouse-up", async () => {
    const onClear = mock(() => {});
    const onComment = mock(() => {});
    const onCopy = mock(() => {});
    const onParentMouseUp = mock(() => {});
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    setup = await testRender(
      <box onMouseUp={onParentMouseUp}>
        <SelectionActionBar
          model={{
            bounds: { top: 0, left: 0, width: 45, height: 3, compact: false },
            commentEnabled: true,
            commentLabel: "Ctrl+N Comment",
            copyLabel: "Ctrl+X Copy",
          }}
          onClear={onClear}
          onComment={onComment}
          onCopy={onCopy}
          onPointerActionStart={() => setup?.renderer.clearSelection()}
          theme={resolveTheme("github-dark-default", null)}
        />
      </box>,
      { width: 60, height: 10 },
    );

    try {
      await act(async () => setup!.renderOnce());
      const rows = setup.captureCharFrame().split("\n");
      for (const [label, callback] of [
        ["Ctrl+N Comment", onComment],
        ["Ctrl+X Copy", onCopy],
        ["Esc Clear", onClear],
      ] as const) {
        const y = rows.findIndex((row) => row.includes(label));
        const x = rows[y]!.indexOf(label);
        await act(async () => setup!.mockMouse.click(x + 1, y, MouseButtons.LEFT));
        expect(callback).toHaveBeenCalledTimes(1);
        expect(setup.renderer.hasSelection).toBe(false);
      }
      expect(onParentMouseUp).not.toHaveBeenCalled();
    } finally {
      await act(async () => setup!.renderer.destroy());
    }
  });
});
