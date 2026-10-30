import { afterAll, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { resolveTheme } from "../themes";
import {
  prefetchHighlightedDiff,
  useHighlightedDiff,
  waitForHighlightedDiffIdle,
} from "./useHighlightedDiff";
import { disposeHighlightWorker, registerHighlightWorker } from "./worker";

afterAll(() => disposeHighlightWorker());

test("repaints mounted provisional rows after a successful background retry", async () => {
  const file = createTestDiffFile({
    after:
      Array.from({ length: 40 }, (_, index) => `const line${index} = ${index};`).join("\n") + "\n",
    before: "",
    id: "mounted-provisional-highlight",
    path: "mounted-provisional-highlight.ts",
  });
  const theme = resolveTheme("github-dark-default", null);
  registerHighlightWorker({
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage() {
      this.onerror?.({ message: "test worker failure" } as ErrorEvent);
    },
    terminate() {
      return Promise.resolve(0);
    },
    unref() {},
  } as unknown as Worker);

  /** Display the hook's result without unrelated state updates or remounts. */
  function HighlightTestHarness() {
    const highlighted = useHighlightedDiff({
      file,
      theme,
      shouldLoadHighlight: true,
    });
    return (
      <text>
        {highlighted?.compact || highlighted?.additionLines.length ? "highlighted" : "plain"}
      </text>
    );
  }

  const setup = await testRender(<HighlightTestHarness />, { width: 40, height: 3 });
  try {
    await act(async () => {
      await waitForHighlightedDiffIdle();
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("plain");

    // A recovered worker supplies a real highlighted result through the same shared cache commit.
    // Only prefetch runs here: the harness receives no new props and is never remounted.
    await act(async () => {
      const successful = await prefetchHighlightedDiff({ file, theme });
      expect(
        successful.compact?.payload.addition.lineOffsets.length ?? successful.additionLines.length,
      ).toBeGreaterThan(0);
    });
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("highlighted");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
    disposeHighlightWorker();
  }
});
