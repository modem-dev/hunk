import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useLayoutEffect, useState } from "react";
import type {
  ExtensionReviewPresentationControls,
  ExtensionReviewPresentationScope,
} from "../../extension-api/types";
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
  const registry = {
    eventBusPhase: "ready",
    extensions: [{ id: "guide", sourcePath: "/guide.ts", origin: "flag" }],
  };

  function Harness() {
    renders += 1;
    const presentation = useExtensionPresentationScope({
      // The host may recreate the result wrapper without retiring its registry.
      extensions: {
        registry,
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

/** Retire scope ownership even when a replacement registry loads the same extension metadata. */
test("clears scopes on registry replacement and rejects controls from the retired registry", async () => {
  const file = createTestDiffFile({ id: "alpha", path: "alpha.ts", before: "a\n", after: "b\n" });
  const scope: ExtensionReviewPresentationScope = {
    generation: "generation:1",
    files: [{ fileId: "alpha", hunkIndexes: [0] }],
  };
  const metadata = [{ id: "guide", sourcePath: "/guide.ts", origin: "flag" }];
  const firstRegistry = { eventBusPhase: "ready", extensions: metadata };
  const secondRegistry = { eventBusPhase: "ready", extensions: metadata };
  let replaceRegistry: ((registry: typeof firstRegistry) => void) | undefined;
  let controls: ExtensionReviewPresentationControls | undefined;
  const observed: { scope: ExtensionReviewPresentationScope | null } = { scope: null };

  function Harness() {
    const [registry, setRegistry] = useState(firstRegistry);
    replaceRegistry = setRegistry;
    const presentation = useExtensionPresentationScope({
      extensions: { registry } as ExtensionLoadResult,
      files: [file],
      getGeneration: () => "generation:1",
    });
    controls = presentation.createControls("guide");
    observed.scope = presentation.scope;
    return <text content={presentation.scope ? "focused" : "all"} />;
  }

  const setup = await testRender(<Harness />, { width: 20, height: 2 });
  try {
    await setup.renderOnce();
    const oldControls = controls!;
    await act(async () => oldControls.setPresentationScope(scope));
    await setup.renderOnce();
    expect(observed.scope).toEqual(scope);

    await act(async () => replaceRegistry!(secondRegistry));
    await setup.renderOnce();
    expect(observed.scope).toBeNull();
    expect(oldControls.setPresentationScope(scope)).toBe(false);
    await act(async () => {
      expect(controls!.setPresentationScope(scope)).toBe(true);
      oldControls.clearPresentationScope();
    });
    await setup.renderOnce();
    expect(observed.scope).toEqual(scope);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
