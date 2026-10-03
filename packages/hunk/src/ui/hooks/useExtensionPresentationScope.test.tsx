import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useLayoutEffect } from "react";
import type { ExtensionReviewPresentationScope } from "../../extension-api/types";
import type { ExtensionLoadResult } from "../../extensions/types";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { useExtensionPresentationScope } from "./useExtensionPresentationScope";

/** Recreate host extension facts while a pane reapplies its unchanged scope. */
test("does not clear and reapply a scope when registry results are recreated", async () => {
  const file = createTestDiffFile({ id: "alpha", path: "alpha.ts", before: "a\n", after: "b\n" });
  const scope: ExtensionReviewPresentationScope = {
    generation: "generation:1",
    files: [{ fileId: "alpha", hunkIndexes: [0] }],
  };
  let renders = 0;

  function Harness() {
    renders += 1;
    const presentation = useExtensionPresentationScope({
      // The host may recreate the result wrapper and registry object without retiring it.
      extensions: {
        registry: {
          eventBusPhase: "ready",
          extensions: [{ id: "guide", sourcePath: "/guide.ts", origin: "flag" }],
        },
      } as unknown as ExtensionLoadResult,
      files: [file],
      getGeneration: () => "generation:1",
    });
    // A pane's action object can be recreated as its host props refresh. Reapply the same
    // presentation request, which must not produce another host render after the first commit.
    const paneActions = {};
    useLayoutEffect(() => {
      presentation.createControls("guide").setPresentationScope(scope);
    }, [paneActions, presentation.createControls]);
    return <text content={presentation.scope ? "focused" : "all"} />;
  }

  const setup = await testRender(<Harness />, { width: 20, height: 2 });
  await setup.renderOnce();

  expect(renders).toBe(2);
});
