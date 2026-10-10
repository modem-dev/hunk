import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { THEMES } from "../themes";
import { DocumentTree } from "./DocumentTree";
import type { DocumentBrowserSnapshot } from "./controller";

test("the tree fills its initial viewport and remains filled after resize without navigation", async () => {
  const snapshot: DocumentBrowserSnapshot = {
    rows: Array.from({ length: 100 }, (_, index) => ({
      depth: 0,
      entry: {
        key: `file-${index + 1}`,
        name: `FILE_${index + 1}`,
        kind: "file",
        hidden: false,
      },
    })),
    selectedKey: "file-1",
    documentKey: null,
    documentEntry: null,
    document: null,
    expanded: new Set(),
    showExcluded: false,
    loading: false,
    notice: null,
  };
  const setup = await testRender(
    <DocumentTree
      snapshot={snapshot}
      theme={THEMES[0]!}
      width={40}
      height={17}
      focused={true}
      onActivate={() => undefined}
    />,
    { width: 40, height: 17 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(30);
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame().match(/FILE_\d+/g)).toHaveLength(17);
    await act(async () => {
      setup.resize(40, 18);
      await setup.renderOnce();
      await Bun.sleep(30);
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame().match(/FILE_\d+/g)).toHaveLength(18);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
