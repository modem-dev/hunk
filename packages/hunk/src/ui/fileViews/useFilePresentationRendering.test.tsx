import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import type { RegisteredFileView } from "../../extensions/types";
import { registeredFileViewKey } from "./state";
import type { FileViewRowFailure } from "./types";
import {
  useFilePresentationRendering,
  type FilePresentationRendering,
} from "./useFilePresentationRendering";

/** Render one valid presentation so row-warning lifetime can follow its layout generation. */
async function renderPresentation() {
  const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
  const view: RegisteredFileView = {
    extensionId: "probe",
    view: {
      id: "preview",
      title: "Preview",
      matches: () => true,
      layout: ({ file: publicFile }) => ({
        rows: [{ id: "row", spans: [{ text: publicFile.path }] }],
        hunkRows: (publicFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
      }),
    },
  };
  const key = registeredFileViewKey(view);
  const files = [file];
  const views = [view];
  const selected = { [file.id]: key };
  const raw = {};
  const epochs = new Map<string, number>();
  const warnings: string[] = [];
  const ignoreIssue = () => {};
  const collectWarning = (message: string) => warnings.push(message);
  let rendering!: FilePresentationRendering;
  let setEnabled!: (enabled: boolean) => void;

  function Harness() {
    const [enabled, updateEnabled] = useState(true);
    setEnabled = updateEnabled;
    rendering = useFilePresentationRendering({
      files,
      selections: enabled ? selected : raw,
      epochs,
      views,
      width: 80,
      onIssue: ignoreIssue,
      onWarning: collectWarning,
    });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 80, height: 8 });
  for (let attempt = 0; attempt < 20 && rendering.layouts.size === 0; attempt += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(5);
    });
  }
  if (rendering.layouts.size === 0) throw new Error("Expected the file presentation to prepare");
  return { file, rendering: () => rendering, setEnabled, setup, warnings };
}

describe("useFilePresentationRendering", () => {
  test("deduplicates row warnings within one layout generation and forgets retired generations", async () => {
    const harness = await renderPresentation();

    try {
      const layout = harness.rendering().layouts.get(harness.file.id)!;
      const failure: FileViewRowFailure = {
        extensionId: layout.extensionId,
        viewId: layout.viewId,
        fileId: harness.file.id,
        filePath: harness.file.path,
        rowId: "row",
        layoutGeneration: layout.layoutGeneration,
        message: "paint exploded",
      };

      await act(async () => {
        harness.rendering().reportRowFailure(failure);
        harness.rendering().reportRowFailure(failure);
      });
      expect(harness.warnings).toEqual([
        'Extension probe file view "preview" row "row" failed rendering alpha.ts • paint exploded',
      ]);

      await act(async () => harness.setEnabled(false));
      expect(harness.rendering().layouts.size).toBe(0);
      await act(async () => harness.rendering().reportRowFailure(failure));
      expect(harness.warnings).toHaveLength(2);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("bounds remembered row failures while retaining the newest entries", async () => {
    const harness = await renderPresentation();

    try {
      const layout = harness.rendering().layouts.get(harness.file.id)!;
      const failure = (rowIndex: number): FileViewRowFailure => ({
        extensionId: layout.extensionId,
        viewId: layout.viewId,
        fileId: harness.file.id,
        filePath: harness.file.path,
        rowId: `row-${rowIndex}`,
        layoutGeneration: layout.layoutGeneration,
        message: "paint exploded",
      });

      await act(async () => {
        for (let rowIndex = 0; rowIndex <= 256; rowIndex += 1) {
          harness.rendering().reportRowFailure(failure(rowIndex));
        }
      });
      expect(harness.warnings).toHaveLength(257);

      await act(async () => {
        harness.rendering().reportRowFailure(failure(0));
        harness.rendering().reportRowFailure(failure(256));
      });
      expect(harness.warnings).toHaveLength(258);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });
});
