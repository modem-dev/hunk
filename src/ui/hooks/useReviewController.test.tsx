import { describe, expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useEffect, useState } from "react";
import { SourceTextTooLargeError } from "../../core/fileSource";
import type { DiffFile } from "../../core/types";
import {
  createTestDeferred,
  createTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../../test/helpers/diff-helpers";
import { useReviewController, type ReviewController } from "./useReviewController";

/** Build a DiffFile with real parsed hunks using the controller's preferred defaults. */
function createDiffFile(
  id: string,
  path: string,
  before: string,
  after: string,
  agent: DiffFile["agent"] = null,
  sourceFetcher?: DiffFile["sourceFetcher"],
): DiffFile {
  return createTestDiffFile({
    after,
    agent,
    before,
    context: 3,
    id,
    language: "typescript",
    path,
    sourceFetcher,
  });
}

/** Build one file with two hunks so selection clamping can be verified across reload-like updates. */
function createTwoHunkFile() {
  const beforeLines = Array.from(
    { length: 12 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[0] = "export const line1 = 100;";
  afterLines[11] = "export const line12 = 1200;";

  return createDiffFile("alpha", "alpha.ts", lines(...beforeLines), lines(...afterLines));
}

/** Build the same file id with only one hunk so stale hunk indices must clamp. */
function createSingleHunkFile() {
  const beforeLines = Array.from(
    { length: 12 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[0] = "export const line1 = 100;";

  return createDiffFile("alpha", "alpha.ts", lines(...beforeLines), lines(...afterLines));
}

/** Build the small one-hunk alpha fixture used by source-loading tests. */
function createAlphaFile(sourceFetcher?: DiffFile["sourceFetcher"]) {
  return createDiffFile(
    "alpha",
    "alpha.ts",
    "export const alpha = 1;\n",
    "export const alpha = 2;\n",
    null,
    sourceFetcher,
  );
}

/** Let deferred filters and follow-up effects settle before reading controller state. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Assert one callback-populated test handle exists before using it. */
function expectValue<T>(value: T): NonNullable<T> {
  expect(value).toBeDefined();
  return value as NonNullable<T>;
}

/** Ids of files currently rendered as collapsed placeholders, read from the observable review stream. */
function collapsedVisibleFileIds(controller: ReviewController): string[] {
  return controller.visibleFiles.filter((file) => file.isCollapsed).map((file) => file.id);
}

function ReviewControllerHarness({
  initialFiles,
  noteGeometry,
  onController,
  onSetFiles,
}: {
  initialFiles: DiffFile[];
  noteGeometry?: Parameters<typeof useReviewController>[0]["noteGeometry"];
  onController: (controller: ReviewController) => void;
  onSetFiles?: (setFiles: (nextFiles: DiffFile[]) => void) => void;
}) {
  const [files, setFiles] = useState(initialFiles);
  const controller = useReviewController({ files, noteGeometry });

  useEffect(() => {
    onController(controller);
  }, [controller, onController]);

  useEffect(() => {
    onSetFiles?.(setFiles);
  }, [onSetFiles]);

  return null;
}

/** Render the controller hook and expose its latest state to tests. */
async function renderReviewController(
  initialFiles: DiffFile[],
  {
    strictMode = false,
    noteGeometry,
  }: {
    strictMode?: boolean;
    noteGeometry?: Parameters<typeof useReviewController>[0]["noteGeometry"];
  } = {},
) {
  const controllerRef: { current: ReviewController | null } = { current: null };
  const setFilesRef: { current: ((nextFiles: DiffFile[]) => void) | null } = { current: null };
  const harness = (
    <ReviewControllerHarness
      initialFiles={initialFiles}
      noteGeometry={noteGeometry}
      onController={(nextController) => {
        controllerRef.current = nextController;
      }}
      onSetFiles={(nextSetFiles) => {
        setFilesRef.current = nextSetFiles;
      }}
    />
  );
  const setup = await testRender(strictMode ? <StrictMode>{harness}</StrictMode> : harness, {
    width: 80,
    height: 4,
  });

  return { controllerRef, setFilesRef, setup };
}

describe("useReviewController", () => {
  test("reselects the first visible file when filtering hides the current selection", async () => {
    const { controllerRef, setup } = await renderReviewController([
      createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\n"),
      createDiffFile(
        "beta",
        "beta.ts",
        "export const beta = 1;\n",
        "export const betaValue = 2;\n",
      ),
    ]);

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("alpha.ts");

      await act(async () => {
        expectValue(controllerRef.current).setFilter("beta");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).visibleFiles.map((file) => file.path)).toEqual([
        "beta.ts",
      ]);
      expect(expectValue(controllerRef.current).selectedFileId).toBe("beta");
      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("beta.ts");
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("collapsing a file swaps in a zero-hunk variant and skips its hunk navigation", async () => {
    const { controllerRef, setup } = await renderReviewController([
      createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\n"),
      createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const beta = 2;\n"),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleFileCollapsed("alpha");
      });
      await flush(setup);

      const collapsed = expectValue(controllerRef.current).visibleFiles.find(
        (file) => file.id === "alpha",
      );
      expect(collapsed?.isCollapsed).toBe(true);
      expect(collapsed?.metadata.hunks).toEqual([]);
      // The collapsed file contributes no hunk cursors, so [ / ] navigation skips it.
      expect(
        expectValue(controllerRef.current).visibleFiles.every((file) =>
          file.id === "alpha" ? file.metadata.hunks.length === 0 : true,
        ),
      ).toBe(true);
      expect(collapsedVisibleFileIds(expectValue(controllerRef.current))).toEqual(["alpha"]);

      // Toggling again expands it back to its real hunks.
      await act(async () => {
        expectValue(controllerRef.current).toggleFileCollapsed("alpha");
      });
      await flush(setup);
      const expanded = expectValue(controllerRef.current).visibleFiles.find(
        (file) => file.id === "alpha",
      );
      expect(expanded?.isCollapsed).toBeFalsy();
      expect(expanded?.metadata.hunks.length).toBeGreaterThan(0);

      // Collapse-all marks every file, expand-all clears the set.
      await act(async () => {
        expectValue(controllerRef.current).toggleAllFilesCollapsed();
      });
      await flush(setup);
      expect(collapsedVisibleFileIds(expectValue(controllerRef.current)).sort()).toEqual([
        "alpha",
        "beta",
      ]);

      await act(async () => {
        expectValue(controllerRef.current).toggleAllFilesCollapsed();
      });
      await flush(setup);
      expect(collapsedVisibleFileIds(expectValue(controllerRef.current))).toEqual([]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("re-pins the selected file's header when collapsing a single file or all files", async () => {
    const { controllerRef, setup } = await renderReviewController([
      createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\n"),
      createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const beta = 2;\n"),
    ]);

    try {
      await flush(setup);

      // Collapsing one file anchors its header to the top so a tall file above the fold can't scroll it off.
      const beforeSingle = expectValue(controllerRef.current).selectedFileTopAlignRequestId;
      await act(async () => {
        expectValue(controllerRef.current).toggleFileCollapsed("alpha");
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedFileTopAlignRequestId).toBeGreaterThan(
        beforeSingle,
      );

      // Bulk collapse re-pins the selected file too, matching the single-file toggle.
      const beforeBulk = expectValue(controllerRef.current).selectedFileTopAlignRequestId;
      await act(async () => {
        expectValue(controllerRef.current).toggleAllFilesCollapsed();
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedFileTopAlignRequestId).toBeGreaterThan(
        beforeBulk,
      );
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("prunes collapse state for a file whose patch is replaced on reload", async () => {
    // A reload swaps the file's sourceFetcher; collapse state keyed by the old patch must not leak.
    const firstFetcher = createTestSourceFetcher(() => null);
    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      createAlphaFile(firstFetcher),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleFileCollapsed("alpha");
      });
      await flush(setup);
      expect(collapsedVisibleFileIds(expectValue(controllerRef.current))).toEqual(["alpha"]);

      // Same id, new fetcher (and thus a new patch) marks the old collapse entry stale, so the
      // reloaded file renders expanded rather than inheriting the previous patch's collapse.
      const secondFetcher = createTestSourceFetcher(() => null);
      await act(async () => {
        expectValue(setFilesRef.current)([createAlphaFile(secondFetcher)]);
      });
      await flush(setup);
      expect(collapsedVisibleFileIds(expectValue(controllerRef.current))).toEqual([]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("clamps the selected hunk index when files update under a soft reload", async () => {
    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      createTwoHunkFile(),
    ]);

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedFile?.metadata.hunks).toHaveLength(2);

      await act(async () => {
        expectValue(controllerRef.current).selectHunk("alpha", 1);
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);

      await act(async () => {
        expectValue(setFilesRef.current)([createSingleHunkFile()]);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).selectedFile?.metadata.hunks).toHaveLength(1);
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("moves through visible files with clamped file-header alignment", async () => {
    const controllerRef: { current: ReviewController | null } = { current: null };
    const setup = await testRender(
      <ReviewControllerHarness
        initialFiles={[
          createTwoHunkFile(),
          createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const beta = 2;\n"),
          createDiffFile(
            "gamma",
            "gamma.ts",
            "export const gamma = 1;\n",
            "export const gamma = 2;\n",
          ),
        ]}
        onController={(nextController) => {
          controllerRef.current = nextController;
        }}
      />,
      { width: 80, height: 4 },
    );

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).selectHunk("alpha", 1);
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);

      await act(async () => {
        expectValue(controllerRef.current).moveToFile(1);
      });
      await flush(setup);

      let controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("beta.ts");
      expect(controller.selectedHunkIndex).toBe(0);
      expect(controller.selectedFileTopAlignRequestId).toBe(1);

      await act(async () => {
        expectValue(controllerRef.current).moveToFile(1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("gamma.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(2);

      await act(async () => {
        expectValue(controllerRef.current).moveToFile(1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("gamma.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(2);

      await act(async () => {
        expectValue(controllerRef.current).moveToFile(-1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("beta.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(3);

      await act(async () => {
        expectValue(controllerRef.current).moveToFile(-1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("alpha.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(4);

      await act(async () => {
        expectValue(controllerRef.current).moveToFile(-1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("alpha.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(4);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("live comment mutations update annotated navigation without remounting the app", async () => {
    const { controllerRef, setup } = await renderReviewController([
      createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\n"),
      createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const beta = 2;\n"),
    ]);

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).liveCommentCount).toBe(0);

      await act(async () => {
        expectValue(controllerRef.current).addLiveComment(
          {
            filePath: "beta.ts",
            side: "new",
            line: 1,
            summary: "Check beta rename",
          },
          "comment-1",
          { reveal: false },
        );
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentCount).toBe(1);
      expect(expectValue(controllerRef.current).liveCommentSummaries).toHaveLength(1);
      expect(
        expectValue(controllerRef.current)
          .visibleFiles.find((file) => file.id === "beta")
          ?.agent?.annotations.map((annotation) => annotation.summary),
      ).toEqual(["Check beta rename"]);

      await act(async () => {
        expectValue(controllerRef.current).moveToAnnotatedHunk(1);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("beta.ts");
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);
      expect(expectValue(controllerRef.current).scrollToNote).toBe(true);

      await act(async () => {
        expectValue(controllerRef.current).removeLiveComment("comment-1");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentCount).toBe(0);
      expect(expectValue(controllerRef.current).liveCommentSummaries).toEqual([]);
      expect(
        expectValue(controllerRef.current).visibleFiles.find((file) => file.id === "beta")?.agent,
      ).toBeNull();
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("live comments validate markup at the published live width", async () => {
    const noteGeometry: { current: { layout: "split" | "stack"; width: number } | null } = {
      current: { layout: "stack", width: 120 },
    };
    const { controllerRef, setup } = await renderReviewController(
      [
        createDiffFile(
          "alpha",
          "alpha.ts",
          "export const alpha = 1;\n",
          "export const alpha = 2;\n",
        ),
      ],
      { noteGeometry },
    );

    try {
      await flush(setup);

      const results: Array<{ markupWidth?: number }> = [];
      await act(async () => {
        results.push(
          expectValue(controllerRef.current).addLiveComment(
            {
              filePath: "alpha.ts",
              side: "new",
              line: 1,
              summary: "Wide note",
              markup: "<box border>ok</box>",
            },
            "comment-wide",
            { reveal: false },
          ),
        );
        // Simulate the user narrowing the terminal / switching layout.
        noteGeometry.current = { layout: "split", width: 120 };
        results.push(
          expectValue(controllerRef.current).addLiveComment(
            {
              filePath: "alpha.ts",
              side: "new",
              line: 1,
              summary: "Docked note",
              markup: "<box border>ok</box>",
            },
            "comment-docked",
            { reveal: false },
          ),
        );
      });

      // stack at width 120 → content width 112; split dock is roughly half.
      expect(results[0]!.markupWidth).toBe(112);
      expect(results[1]!.markupWidth).toBeLessThan(70);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("live comments with degraded markup return render notes for the agent", async () => {
    const { controllerRef, setup } = await renderReviewController([
      createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\n"),
    ]);

    try {
      await flush(setup);

      const results: Array<{ markupNotes?: string[] }> = [];
      await act(async () => {
        results.push(
          expectValue(controllerRef.current).addLiveComment(
            {
              filePath: "alpha.ts",
              side: "new",
              line: 1,
              summary: "Degraded markup",
              markup: "<sparkline>1 2 3</sparkline>",
            },
            "comment-degraded",
            { reveal: false },
          ),
          expectValue(controllerRef.current).addLiveComment(
            {
              filePath: "alpha.ts",
              side: "new",
              line: 1,
              summary: "Clean markup",
              markup: "<box border>ok</box>",
            },
            "comment-clean",
            { reveal: false },
          ),
        );
      });

      expect(results[0]!.markupNotes?.some((note) => note.includes("unknown tag"))).toBe(true);
      expect(results[1]!.markupNotes).toBeUndefined();
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("batch live comments validate together and reveal the first applied hunk", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);

      await act(async () => {
        const result = expectValue(controllerRef.current).addLiveCommentBatch(
          [
            {
              filePath: "alpha.ts",
              hunkIndex: 1,
              summary: "Later hunk note",
            },
            {
              filePath: "alpha.ts",
              hunkIndex: 0,
              summary: "Earlier hunk note",
            },
          ],
          "request-1",
          { revealMode: "first" },
        );

        expect(result.applied.map((comment) => comment.hunkIndex)).toEqual([1, 0]);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentCount).toBe(2);
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);
      expect(
        expectValue(controllerRef.current).liveCommentSummaries.map((comment) => comment.summary),
      ).toEqual(["Later hunk note", "Earlier hunk note"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("batch live comments do not mutate state when any target is invalid", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);

      await act(async () => {
        expect(() =>
          expectValue(controllerRef.current).addLiveCommentBatch(
            [
              {
                filePath: "alpha.ts",
                hunkIndex: 0,
                summary: "Valid note",
              },
              {
                filePath: "missing.ts",
                hunkIndex: 0,
                summary: "Invalid note",
              },
            ],
            "request-2",
          ),
        ).toThrow("No diff file matches missing.ts.");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentCount).toBe(0);
      expect(expectValue(controllerRef.current).liveCommentSummaries).toEqual([]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("sidecar annotations are exposed as AI review notes", async () => {
    const controllerRef: { current: ReviewController | null } = { current: null };
    const setup = await testRender(
      <ReviewControllerHarness
        initialFiles={[
          createDiffFile(
            "alpha",
            "alpha.ts",
            "export const alpha = 1;\n",
            "export const alpha = 2;\n",
            {
              path: "alpha.ts",
              annotations: [
                {
                  id: "ai:1",
                  source: "ai",
                  summary: "Prefer a named constant.",
                  rationale: "It documents the changed value.",
                  newRange: [1, 1],
                  author: "assistant",
                },
              ],
            },
          ),
        ]}
        onController={(nextController) => {
          controllerRef.current = nextController;
        }}
      />,
      { width: 80, height: 4 },
    );

    try {
      await flush(setup);

      expect(expectValue(controllerRef.current).reviewNoteSummaries).toMatchObject([
        {
          noteId: "ai:1",
          source: "ai",
          filePath: "alpha.ts",
          newRange: [1, 1],
          body: "Prefer a named constant.\n\nIt documents the changed value.",
          author: "assistant",
          editable: false,
        },
      ]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("user note drafts can be saved, removed, and exposed as review notes", async () => {
    const controllerRef: { current: ReviewController | null } = { current: null };
    const setup = await testRender(
      <ReviewControllerHarness
        initialFiles={[
          createDiffFile(
            "alpha",
            "alpha.ts",
            "export const alpha = 1;\n",
            "export const alpha = 2;\n",
          ),
        ]}
        onController={(nextController) => {
          controllerRef.current = nextController;
        }}
      />,
      { width: 80, height: 4 },
    );

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).startUserNote();
        expectValue(controllerRef.current).updateDraftNote("Please add a regression test.");
      });
      await flush(setup);

      let savedNoteId = "";
      await act(async () => {
        const saved = expectValue(controllerRef.current).saveDraftNote();
        savedNoteId = saved?.id ?? "";
      });
      await flush(setup);

      expect(savedNoteId).toStartWith("user:");
      expect(expectValue(controllerRef.current).userNotesByFileId.alpha).toHaveLength(1);
      expect(expectValue(controllerRef.current).reviewNoteSummaries).toMatchObject([
        {
          noteId: savedNoteId,
          source: "user",
          filePath: "alpha.ts",
          hunkIndex: 0,
          newRange: [1, 1],
          body: "Please add a regression test.",
          editable: true,
        },
      ]);

      await act(async () => {
        const result = expectValue(controllerRef.current).removeLiveComment(savedNoteId);
        expect(result).toMatchObject({
          commentId: savedNoteId,
          removed: true,
          remainingCommentCount: 0,
          source: "user",
        });
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).userNotesByFileId.alpha).toBeUndefined();
      expect(expectValue(controllerRef.current).reviewNoteSummaries).toEqual([]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("rapid duplicate saves persist exactly one user note with a unique id", async () => {
    const { controllerRef, setup } = await renderReviewController([createAlphaFile()]);
    const fixedNow = 1_700_000_000_000;
    const dateNowSpy = spyOn(Date, "now").mockReturnValue(fixedNow);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).startUserNote();
        expectValue(controllerRef.current).updateDraftNote("Save me once.");
      });
      await flush(setup);

      // Coalesced Ctrl+S key events invoke save twice before the draft-clearing
      // state update commits; only the first call may persist a note.
      const savedIds: { first?: string; second?: string; followUp?: string } = {};
      await act(async () => {
        const controller = expectValue(controllerRef.current);
        savedIds.first = controller.saveDraftNote()?.id;
        savedIds.second = controller.saveDraftNote()?.id;
      });
      await flush(setup);

      expect(savedIds.first).toBe(`user:${fixedNow}-1`);
      expect(savedIds.second).toBeUndefined();
      expect(expectValue(controllerRef.current).userNotesByFileId.alpha).toHaveLength(1);

      // A follow-up draft saved within the same millisecond still gets a unique id.
      await act(async () => {
        expectValue(controllerRef.current).startUserNote();
      });
      await flush(setup);
      await act(async () => {
        expectValue(controllerRef.current).updateDraftNote("Save me too.");
      });
      await flush(setup);

      await act(async () => {
        savedIds.followUp = expectValue(controllerRef.current).saveDraftNote()?.id;
      });
      await flush(setup);

      expect(savedIds.followUp).toBe(`user:${fixedNow}-2`);
      expect(savedIds.followUp).not.toBe(savedIds.first);
      expect(expectValue(controllerRef.current).userNotesByFileId.alpha).toHaveLength(2);
    } finally {
      dateNowSpy.mockRestore();
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("session clear can include human user notes", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);

      await act(async () => {
        const controller = expectValue(controllerRef.current);
        controller.addLiveComment(
          { filePath: "alpha.ts", hunkIndex: 0, summary: "Agent cleanup note" },
          "comment-1",
        );
        controller.startUserNote("alpha", 0);
      });
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).updateDraftNote("Human cleanup note.");
      });
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).saveDraftNote();
      });
      await flush(setup);

      await act(async () => {
        const result = expectValue(controllerRef.current).removeLiveComment("comment-1");
        expect(result).toMatchObject({
          commentId: "comment-1",
          removed: true,
          remainingCommentCount: 1,
          source: "agent",
        });
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentSummaries).toEqual([]);
      expect(expectValue(controllerRef.current).userNotesByFileId.alpha).toHaveLength(1);

      await act(async () => {
        expectValue(controllerRef.current).addLiveComment(
          { filePath: "alpha.ts", hunkIndex: 0, summary: "Default clear agent note" },
          "comment-2",
        );
      });
      await flush(setup);

      await act(async () => {
        const result = expectValue(controllerRef.current).clearLiveComments();
        expect(result).toMatchObject({
          removedCount: 1,
          remainingCommentCount: 1,
          removedLiveCommentCount: 1,
          removedUserNoteCount: 0,
          remainingUserNoteCount: 1,
        });
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentSummaries).toEqual([]);
      expect(expectValue(controllerRef.current).userNotesByFileId.alpha).toHaveLength(1);

      await act(async () => {
        expectValue(controllerRef.current).addLiveComment(
          { filePath: "alpha.ts", hunkIndex: 0, summary: "Inclusive clear agent note" },
          "comment-3",
        );
      });
      await flush(setup);

      await act(async () => {
        const result = expectValue(controllerRef.current).clearLiveComments(undefined, {
          includeUser: true,
        });
        expect(result).toMatchObject({
          removedCount: 2,
          remainingCommentCount: 0,
          removedLiveCommentCount: 1,
          removedUserNoteCount: 1,
        });
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentSummaries).toEqual([]);
      expect(expectValue(controllerRef.current).userNotesByFileId).toEqual({});
      expect(expectValue(controllerRef.current).reviewNoteSummaries).toEqual([]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleGap flips per-file expansion state and lazily loads source text", async () => {
    const fakeFetcher = createTestSourceFetcher((side) =>
      side === "new" ? "alpha\nbeta\ngamma\n" : null,
    );

    const { controllerRef, setup } = await renderReviewController([createAlphaFile(fakeFetcher)]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      const expanded = expectValue(controllerRef.current).expandedGapsByFileId["alpha"];
      expect(expanded?.has("before:0")).toBe(true);
      const status = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(status?.kind).toBe("loaded");
      if (status?.kind === "loaded") {
        expect(status.text).toBe("alpha\nbeta\ngamma\n");
      }
      expect(fakeFetcher.calls.length).toBeGreaterThanOrEqual(1);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      const reCollapsed = expectValue(controllerRef.current).expandedGapsByFileId["alpha"];
      expect(reCollapsed?.has("before:0")).toBe(false);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleGap settles source status under React StrictMode", async () => {
    const deferred = createTestDeferred<string | null>();
    const fakeFetcher = createTestSourceFetcher(() => deferred.promise);

    const { controllerRef, setup } = await renderReviewController([createAlphaFile(fakeFetcher)], {
      strictMode: true,
    });

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]?.kind).toBe(
        "loading",
      );

      deferred.resolve("strict mode source\n");
      await flush(setup);

      const status = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(status?.kind).toBe("loaded");
      if (status?.kind === "loaded") {
        expect(status.text).toBe("strict mode source\n");
      }
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleGap is a no-op for files without a source fetcher", async () => {
    const { controllerRef, setup } = await renderReviewController([createAlphaFile()]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).expandedGapsByFileId["alpha"]).toBeUndefined();
      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]).toBeUndefined();
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleSelectedHunkGap expands the nearest gap for the current selection", async () => {
    const beforeLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[4] = "line 5 changed";
    const after = lines(...afterLines);
    const sourceFetcher = createTestSourceFetcher((side) => (side === "new" ? after : null));
    const file = createTestDiffFile({
      after,
      before: lines(...beforeLines),
      context: 3,
      id: "alpha",
      path: "alpha.ts",
      sourceFetcher,
    });

    const { controllerRef, setup } = await renderReviewController([file]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleSelectedHunkGap();
      });
      await flush(setup);

      const expanded = expectValue(controllerRef.current).expandedGapsByFileId["alpha"];
      expect(expanded?.has("before:0")).toBe(true);
      expect(sourceFetcher.calls).toEqual(["new"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleGap surfaces an error status when the fetcher resolves null", async () => {
    const failingFetcher = createTestSourceFetcher(() => null);

    const { controllerRef, setup } = await renderReviewController([
      createAlphaFile(failingFetcher),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      const status = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(status?.kind).toBe("error");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleGap surfaces an error status and logs context when the fetcher rejects", async () => {
    const originalConsoleError = console.error;
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    const failingFetcher = createTestSourceFetcher(() => {
      throw new Error("source unavailable");
    });

    const { controllerRef, setup } = await renderReviewController([
      createAlphaFile(failingFetcher),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      const status = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(status?.kind).toBe("error");
      expect(String(loggedErrors[0]?.[0])).toContain("alpha.ts");
      expect(String(loggedErrors[0]?.[0])).toContain("alpha");
    } finally {
      console.error = originalConsoleError;
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleGap marks over-limit source loads as too large", async () => {
    const tooLargeFetcher = createTestSourceFetcher(() => {
      throw new SourceTextTooLargeError(5);
    });

    const { controllerRef, setup } = await renderReviewController([
      createAlphaFile(tooLargeFetcher),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      const status = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(status).toEqual({ kind: "error", reason: "too-large" });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleGap caches loaded text and does not re-fetch on the second open", async () => {
    let readCount = 0;
    const trackedFetcher = createTestSourceFetcher((side) => {
      readCount += 1;
      return side === "new" ? `read-${readCount}\n` : null;
    });

    const { controllerRef, setup } = await renderReviewController([
      createAlphaFile(trackedFetcher),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);
      const callsAfterFirst = trackedFetcher.calls.length;

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      const status = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(status?.kind).toBe("loaded");
      if (status?.kind === "loaded") {
        // Text reflects the first read, not a later one.
        expect(status.text).toBe("read-1\n");
      }
      expect(trackedFetcher.calls.length).toBe(callsAfterFirst);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggleGap requests old-side source for deleted files", async () => {
    const trackedFetcher = createTestSourceFetcher((side) => (side === "old" ? "removed\n" : null));

    const { controllerRef, setup } = await renderReviewController([
      createDiffFile("removed", "removed.ts", "removed\n", "", null, trackedFetcher),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("removed", "trailing:0");
      });
      await flush(setup);

      expect(trackedFetcher.calls).toEqual(["old"]);
      const status = expectValue(controllerRef.current).sourceStatusByFileId["removed"];
      expect(status?.kind).toBe("loaded");
      if (status?.kind === "loaded") {
        expect(status.text).toBe("removed\n");
      }
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a soft reload that replaces a file's sourceFetcher invalidates cached source and expansion", async () => {
    const firstFetcher = createTestSourceFetcher((side) => (side === "new" ? "first\n" : null));
    const secondFetcher = createTestSourceFetcher((side) => (side === "new" ? "second\n" : null));
    const baseFile = createAlphaFile();

    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      { ...baseFile, sourceFetcher: firstFetcher },
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      // First fetch resolved against the original fetcher.
      const initialStatus = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(initialStatus?.kind).toBe("loaded");
      if (initialStatus?.kind === "loaded") {
        expect(initialStatus.text).toBe("first\n");
      }
      expect(
        expectValue(controllerRef.current).expandedGapsByFileId["alpha"]?.has("before:0"),
      ).toBe(true);

      // Simulate a soft reload: same file id, different sourceFetcher (and patch).
      await act(async () => {
        expectValue(setFilesRef.current)([{ ...baseFile, sourceFetcher: secondFetcher }]);
      });
      await flush(setup);

      // The stale loaded text and stale expansion must be cleared so the
      // renderer doesn't combine old source with the new patch.
      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]).toBeUndefined();
      expect(expectValue(controllerRef.current).expandedGapsByFileId["alpha"]).toBeUndefined();

      // Toggling again now fetches via the new fetcher and reports its text.
      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      const refreshedStatus = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(refreshedStatus?.kind).toBe("loaded");
      if (refreshedStatus?.kind === "loaded") {
        expect(refreshedStatus.text).toBe("second\n");
      }
      expect(secondFetcher.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a pending source load cannot repopulate state after a soft reload", async () => {
    const firstLoad = createTestDeferred<string | null>();
    const firstFetcher = createTestSourceFetcher(() => firstLoad.promise);
    const secondFetcher = createTestSourceFetcher((side) => (side === "new" ? "second\n" : null));
    const baseFile = createAlphaFile();

    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      { ...baseFile, sourceFetcher: firstFetcher },
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]?.kind).toBe(
        "loading",
      );

      await act(async () => {
        expectValue(setFilesRef.current)([{ ...baseFile, sourceFetcher: secondFetcher }]);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]).toBeUndefined();
      expect(expectValue(controllerRef.current).expandedGapsByFileId["alpha"]).toBeUndefined();

      await act(async () => {
        firstLoad.resolve("first\n");
        await firstLoad.promise;
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]).toBeUndefined();

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      const refreshedStatus = expectValue(controllerRef.current).sourceStatusByFileId["alpha"];
      expect(refreshedStatus?.kind).toBe("loaded");
      if (refreshedStatus?.kind === "loaded") {
        expect(refreshedStatus.text).toBe("second\n");
      }
      expect(firstFetcher.calls).toEqual(["new"]);
      expect(secondFetcher.calls).toEqual(["new"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a stale rejected source load is logged without repopulating state", async () => {
    const originalConsoleError = console.error;
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    const firstLoad = createTestDeferred<string | null>();
    const firstFetcher = createTestSourceFetcher(() => firstLoad.promise);
    const secondFetcher = createTestSourceFetcher((side) => (side === "new" ? "second\n" : null));
    const baseFile = createAlphaFile();

    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      { ...baseFile, sourceFetcher: firstFetcher },
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      await act(async () => {
        expectValue(setFilesRef.current)([{ ...baseFile, sourceFetcher: secondFetcher }]);
      });
      await flush(setup);

      await act(async () => {
        firstLoad.reject(new Error("stale failure"));
        await firstLoad.promise.catch(() => undefined);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]).toBeUndefined();
      expect(String(loggedErrors[0]?.[0])).toContain("ignored stale new source load failure");
      expect(String(loggedErrors[0]?.[0])).toContain("alpha.ts");
      expect(String(loggedErrors[0]?.[0])).toContain("alpha");
    } finally {
      console.error = originalConsoleError;
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
