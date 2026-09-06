import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import { AppHost } from "./AppHost";

mock.restore();

let mountReview: (() => void) | undefined;

/** Mount AppHost after another surface has already committed into the same stable root. */
function DynamicReviewHost({ onReady }: { onReady: () => void }) {
  const [mounted, setMounted] = useState(false);
  mountReview = () => setMounted(true);
  if (!mounted) return <text>History surface</text>;
  return (
    <AppHost
      bootstrap={createTestVcsAppBootstrap({
        changesetId: "dynamic-review",
        files: [
          createTestDiffFile({
            id: "dynamic.ts",
            path: "dynamic.ts",
            before: "export const value = 1;\n",
            after: "export const value = 2;\n",
          }),
        ],
      })}
      onFirstFrameReady={onReady}
      returnToHistory
    />
  );
}

test("AppHost paints and reports readiness when mounted after a retained surface", async () => {
  const ready = mock(() => undefined);
  const setup = await testRender(<DynamicReviewHost onReady={ready} />, {
    width: 100,
    height: 18,
  });
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("History surface");

    act(() => mountReview?.());
    await Bun.sleep(20);
    await setup.renderOnce();
    await Bun.sleep(20);
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("dynamic.ts");
    expect(ready).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
    mountReview = undefined;
  }
});
