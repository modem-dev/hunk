import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement, useState } from "react";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import type { DiffFile } from "../../core/changeset/model";
import type { RegisteredLineHighlighter } from "../../extensions/types";
import { registeredLineHighlighterKey } from "./state";
import { scopedEpoch } from "../lib/scopedEpochs";
import {
  useLineHighlightsController,
  type LineHighlightsController,
} from "./useLineHighlightsController";

const file = createTestDiffFile({ id: "reviewed", path: "reviewed.ts" });
const registered: RegisteredLineHighlighter = {
  extensionId: "search",
  highlighter: { id: "matches", highlight: () => null },
};
const key = registeredLineHighlighterKey(registered);

/** Mount the controller with replaceable review files. */
async function renderController(initialFiles: readonly DiffFile[]) {
  let controller!: LineHighlightsController;
  let setFiles!: (files: readonly DiffFile[]) => void;
  const notices: string[] = [];
  const highlighters = [registered];

  function Harness() {
    const [files, replaceFiles] = useState(initialFiles);
    setFiles = replaceFiles;
    controller = useLineHighlightsController({
      files,
      highlighters,
      showNotice: (message) => notices.push(message),
    });
    return null;
  }

  const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
  return {
    controller: () => controller,
    setFiles,
    notices,
    setup,
    destroy: () => act(async () => setup.renderer.destroy()),
  };
}

describe("useLineHighlightsController", () => {
  test("refresh bumps the highlighter's epoch, whole and file-scoped", async () => {
    const harness = await renderController([file]);
    try {
      const controls = harness.controller().createControls("search");
      await act(async () => {
        controls.refresh("matches");
        await harness.setup.renderOnce();
      });
      expect(scopedEpoch(harness.controller().epochs, key, file.id)).toBe(1);

      await act(async () => {
        controls.refresh("matches", { fileId: file.id });
        await harness.setup.renderOnce();
      });
      expect(scopedEpoch(harness.controller().epochs, key, file.id)).toBe(2);
      expect(scopedEpoch(harness.controller().epochs, key, "other-file")).toBe(1);
      expect(harness.notices).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });

  test("warns for unknown ids and stays silent for stale file ids", async () => {
    const harness = await renderController([file]);
    try {
      const controls = harness.controller().createControls("search");
      await act(async () => {
        controls.refresh("unknown");
        controls.refresh("matches", { fileId: "gone" });
        await harness.setup.renderOnce();
      });
      expect(harness.notices).toEqual([
        'Extension search targeted unknown line highlighter "unknown"',
      ]);
      expect(scopedEpoch(harness.controller().epochs, key, file.id)).toBe(0);
    } finally {
      await harness.destroy();
    }
  });

  test("resolves qualified ids across extensions", async () => {
    const harness = await renderController([file]);
    try {
      const controls = harness.controller().createControls("other-extension");
      await act(async () => {
        controls.refresh("search:matches");
        await harness.setup.renderOnce();
      });
      expect(scopedEpoch(harness.controller().epochs, key, file.id)).toBe(1);
    } finally {
      await harness.destroy();
    }
  });

  test("reconciles file-scoped epochs away when a reload drops the file", async () => {
    const harness = await renderController([file]);
    try {
      const controls = harness.controller().createControls("search");
      await act(async () => {
        controls.refresh("matches", { fileId: file.id });
        await harness.setup.renderOnce();
      });
      expect(scopedEpoch(harness.controller().epochs, key, file.id)).toBe(1);

      await act(async () => {
        harness.setFiles([]);
        await harness.setup.renderOnce();
      });
      expect(scopedEpoch(harness.controller().epochs, key, file.id)).toBe(0);
    } finally {
      await harness.destroy();
    }
  });
});
