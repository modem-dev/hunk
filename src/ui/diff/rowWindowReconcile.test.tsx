import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";

/**
 * Characterizes the @opentui/solid reconciler hazard behind the blank-diff-body regression and the
 * fix that `PierreDiffView` relies on.
 *
 * `PierreDiffView` renders a file body as `topSpacer? + <For rows> + bottomSpacer?` inside one
 * column. While a tall file is mounted but still scrolled off-screen (file-level overscan), its row
 * window is zero-height, so the `<For>` renders empty for one or more commits. When it later grows,
 * `reconcileArrays` computes its insert anchor as `getNextSibling(previousArray[last])` — which is
 * null for a previously-empty array — and `insertNode(parent, row, null)` appends the first rows to
 * the END of the parent, landing *after* the bottom spacer. With a tall file that spacer is far
 * taller than the viewport, so the rows scroll off-screen and the body looks blank until a remount.
 *
 * The fix gives the `<For>` its own always-mounted parent box so "append to end" is always the
 * correct position and the surrounding spacers keep their order. `captureCharFrame` renders mounted
 * children top-to-bottom, so the rows' position relative to a following sentinel reveals the order.
 */
describe("row window reconcile (For grown from empty before a sibling)", () => {
  test("an unwrapped For appends grown rows after the following sibling (the bug)", async () => {
    const [rows, setRows] = createSignal<string[]>([]);
    const setup = await testRender(
      () => (
        <box style={{ flexDirection: "column" }}>
          <For each={rows()}>{(row) => <text>{`ROW_${row}`}</text>}</For>
          <Show when={true}>
            <text>SENTINEL_BOTTOM</text>
          </Show>
        </box>
      ),
      { width: 40, height: 12 },
    );

    try {
      await setup.renderOnce();
      await Bun.sleep(10);
      await setup.renderOnce();

      setRows(["a", "b", "c"]);
      await Bun.sleep(10);
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      const firstRow = frame.indexOf("ROW_a");
      const sentinel = frame.indexOf("SENTINEL_BOTTOM");

      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(sentinel).toBeGreaterThanOrEqual(0);
      // Rows render AFTER the sentinel — exactly the mis-ordering that blanks a scrolled-into body.
      expect(firstRow).toBeGreaterThan(sentinel);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("wrapping the For in its own box keeps grown rows before the sibling (the fix)", async () => {
    const [rows, setRows] = createSignal<string[]>([]);
    const setup = await testRender(
      () => (
        <box style={{ flexDirection: "column" }}>
          <box style={{ flexDirection: "column" }}>
            <For each={rows()}>{(row) => <text>{`ROW_${row}`}</text>}</For>
          </box>
          <Show when={true}>
            <text>SENTINEL_BOTTOM</text>
          </Show>
        </box>
      ),
      { width: 40, height: 12 },
    );

    try {
      await setup.renderOnce();
      await Bun.sleep(10);
      await setup.renderOnce();

      setRows(["a", "b", "c"]);
      await Bun.sleep(10);
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      const firstRow = frame.indexOf("ROW_a");
      const sentinel = frame.indexOf("SENTINEL_BOTTOM");

      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(sentinel).toBeGreaterThanOrEqual(0);
      // Rows render BEFORE the sentinel, so a scrolled-into file body stays visible at its window.
      expect(firstRow).toBeLessThan(sentinel);
    } finally {
      setup.renderer.destroy();
    }
  });
});
