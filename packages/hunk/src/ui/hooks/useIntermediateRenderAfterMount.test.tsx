import { expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { useRenderer } from "@opentui/react";
import { useIntermediateRenderAfterMount } from "./useIntermediateRenderAfterMount";

mock.restore();

let changeGeometry: (() => void) | undefined;

/** Exercise the post-mount redraw hook through a committed geometry change. */
function TestPostMountRender() {
  const renderer = useRenderer();
  const [geometry, setGeometry] = useState(1);
  changeGeometry = () => setGeometry((value) => value + 1);
  useIntermediateRenderAfterMount(renderer, [geometry]);
  return <text>{geometry}</text>;
}

test("post-mount intermediate rendering skips initial dynamic mount and redraws later geometry", async () => {
  const setup = await testRender(<TestPostMountRender />, { width: 20, height: 4 });
  const intermediateRender = mock(() => undefined);
  setup.renderer.intermediateRender = intermediateRender;
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    expect(intermediateRender).not.toHaveBeenCalled();

    await act(async () => {
      changeGeometry?.();
      await setup.renderOnce();
    });
    expect(intermediateRender).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
    changeGeometry = undefined;
  }
});
