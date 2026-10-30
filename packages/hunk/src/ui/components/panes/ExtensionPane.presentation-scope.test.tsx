import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useLayoutEffect, useState, type ReactNode } from "react";
import type {
  ExtensionPaneProps,
  ExtensionReviewPresentationScope,
} from "../../../extension-api/types";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import { toReadOnlyFileViews } from "../../../extensions/events";
import type { ExtensionLoadResult, RegisteredPane } from "../../../extensions/types";
import { useExtensionPresentationScope } from "../../hooks/useExtensionPresentationScope";
import { filterFilesByExtensionPresentationScope } from "../../lib/extensionPresentationScope";
import { resolveTheme } from "../../themes";
import { ExtensionPaneHost } from "./ExtensionPane";

/** Build the minimal registration needed to mount a pane in the host harness. */
function registeredPane(component: (props: ExtensionPaneProps) => ReactNode) {
  return {
    extensionId: "guide",
    pane: {
      id: "guide",
      placement: "left",
      width: { preferred: 34, min: 22 },
      component,
    },
  } as unknown as RegisteredPane;
}

/** Keep a focused pane mounted while its active scope changes the host file projection. */
test("does not loop when an active presentation scope filters an open pane", async () => {
  const files = [
    createTestDiffFile({ id: "alpha", path: "alpha.ts", before: "a\n", after: "b\n" }),
    createTestDiffFile({ id: "beta", path: "beta.ts", before: "a\n", after: "c\n" }),
  ];
  const scope: ExtensionReviewPresentationScope = {
    generation: "generation:1",
    files: [{ fileId: "alpha", hunkIndexes: [0] }],
  };
  const extensions = {
    registry: {
      eventBusPhase: "ready",
      extensions: [{ id: "guide", sourcePath: "/guide.ts", origin: "flag" }],
    },
  } as unknown as ExtensionLoadResult;
  let paneRenders = 0;

  function GuideLikePane(props: ExtensionPaneProps) {
    paneRenders += 1;
    useLayoutEffect(() => {
      props.actions.setPresentationScope(scope);
      return () => props.actions.clearPresentationScope();
    }, [props.actions]);
    return <text content="guide" />;
  }

  function Harness() {
    const presentation = useExtensionPresentationScope({
      extensions,
      files,
      getGeneration: () => "generation:1",
    });
    const [, setAvailabilityRevision] = useState(0);
    // The real pane controller publishes an availability snapshot when its request changes.
    // This makes the host/pane harness exercise that same active-scope rerender path.
    useLayoutEffect(() => {
      setAvailabilityRevision((revision) => revision + 1);
    }, [presentation.scope]);
    const visibleFiles = filterFilesByExtensionPresentationScope(files, presentation.scope);
    return (
      <ExtensionPaneHost
        registered={registeredPane(GuideLikePane)}
        files={visibleFiles}
        fileViews={toReadOnlyFileViews(visibleFiles)}
        selectedFileId={visibleFiles[0]?.id ?? null}
        selectedHunkIndex={0}
        reviewGeneration="generation:1"
        theme={resolveTheme("github-dark-default", null)}
        width={34}
        height={20}
        placement="left"
        currentLine={null}
        keybindings={{ matches: () => false, getKeys: () => [] }}
        notify={() => {}}
        presentation={presentation.createControls("guide")}
        onSelectFile={() => {}}
        onSelectHunk={() => {}}
        onRevealLine={() => "line"}
      />
    );
  }

  const setup = await testRender(<Harness />, { width: 60, height: 20 });
  try {
    await act(async () => setup.renderOnce());
    expect(paneRenders).toBe(2);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
