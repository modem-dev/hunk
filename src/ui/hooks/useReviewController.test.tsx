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
import { measureDiffSectionGeometry } from "../diff/diffSectionGeometry";
import { buildLineCursors, type LineCursor } from "../lib/lineCursors";
import { resolveTheme } from "../themes";
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

/** Build one file with three separated hunks for counted navigation coverage. */
function createThreeHunkFile() {
  const beforeLines = Array.from(
    { length: 30 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[0] = "export const line1 = 100;";
  afterLines[14] = "export const line15 = 1500;";
  afterLines[29] = "export const line30 = 3000;";

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

/**
 * Build the alpha fixture as a later reload would see it, with changed content.
 *
 * Content-derived source identity is what retires expansion and loaded source, so a
 * reload test has to change the file rather than only hand it a new fetcher object.
 */
function createReloadedAlphaFile(sourceFetcher?: DiffFile["sourceFetcher"]) {
  return createDiffFile(
    "alpha",
    "alpha.ts",
    "export const alpha = 1;\n",
    "export const alpha = 3;\n",
    null,
    sourceFetcher,
  );
}

/** Build one file with two independently expandable gaps. */
function createTwoGapFile(sourceFetcher: DiffFile["sourceFetcher"]) {
  const beforeLines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
  const afterLines = [...beforeLines];
  afterLines[9] = "line 10 changed";
  afterLines[39] = "line 40 changed";
  return createDiffFile(
    "alpha",
    "alpha.ts",
    lines(...beforeLines),
    lines(...afterLines),
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

function ReviewControllerHarness({
  initialFiles,
  noteGeometry,
  stmlEnabled,
  onController,
  onSetFiles,
}: {
  initialFiles: DiffFile[];
  noteGeometry?: Parameters<typeof useReviewController>[0]["noteGeometry"];
  stmlEnabled?: boolean;
  onController: (controller: ReviewController) => void;
  onSetFiles?: (setFiles: (nextFiles: DiffFile[]) => void) => void;
}) {
  const [files, setFiles] = useState(initialFiles);
  const [lineCursors, setLineCursors] = useState<LineCursor[]>([]);
  const controller = useReviewController({ files, lineCursors, noteGeometry, stmlEnabled });
  const visibleFiles = controller.visibleFiles;
  const { expandedGapsByFileId, sourceStatusByFileId } = controller;

  useEffect(() => {
    setLineCursors(
      buildLineCursors(
        visibleFiles,
        visibleFiles.map((file) =>
          measureDiffSectionGeometry(
            file,
            "stack",
            true,
            resolveTheme("github-dark-default", null),
            [],
            0,
            true,
            false,
            expandedGapsByFileId[file.id],
            sourceStatusByFileId[file.id],
          ),
        ),
      ),
    );
  }, [expandedGapsByFileId, sourceStatusByFileId, visibleFiles]);

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
    stmlEnabled,
  }: {
    strictMode?: boolean;
    noteGeometry?: Parameters<typeof useReviewController>[0]["noteGeometry"];
    stmlEnabled?: boolean;
  } = {},
) {
  const controllerRef: { current: ReviewController | null } = { current: null };
  const setFilesRef: { current: ((nextFiles: DiffFile[]) => void) | null } = { current: null };
  const harness = (
    <ReviewControllerHarness
      initialFiles={initialFiles}
      noteGeometry={noteGeometry}
      stmlEnabled={stmlEnabled}
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
  test("preserves a filtered-out selection until the reviewer clears the filter", async () => {
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
      expect(expectValue(controllerRef.current).selectedFileId).toBe("alpha");
      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("alpha.ts");
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);

      await act(async () => {
        expectValue(controllerRef.current).clearFilter();
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).visibleFiles.map((file) => file.path)).toEqual([
        "alpha.ts",
        "beta.ts",
      ]);
      expect(expectValue(controllerRef.current).selectedFileId).toBe("alpha");
      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("alpha.ts");
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

  test("keeps review stream identities stable across selection-only navigation", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);
      const initialVisibleFiles = expectValue(controllerRef.current).visibleFiles;

      await act(async () => {
        expectValue(controllerRef.current).selectHunk("alpha", 1);
      });
      await flush(setup);

      const controller = expectValue(controllerRef.current);
      expect(controller.selectedHunkIndex).toBe(1);
      expect(controller.visibleFiles).toBe(initialVisibleFiles);
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
        expectValue(controllerRef.current).moveSelection("file", 1);
      });
      await flush(setup);

      let controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("beta.ts");
      expect(controller.selectedHunkIndex).toBe(0);
      expect(controller.selectedFileTopAlignRequestId).toBe(1);

      await act(async () => {
        expectValue(controllerRef.current).moveSelection("file", 1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("gamma.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(2);

      await act(async () => {
        expectValue(controllerRef.current).moveSelection("file", 1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("gamma.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(2);

      await act(async () => {
        expectValue(controllerRef.current).moveSelection("file", -1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("beta.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(3);

      await act(async () => {
        expectValue(controllerRef.current).moveSelection("file", -1);
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.path).toBe("alpha.ts");
      expect(controller.selectedFileTopAlignRequestId).toBe(4);

      await act(async () => {
        expectValue(controllerRef.current).moveSelection("file", -1);
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

  test("moves across several files in one counted selection request", async () => {
    const { controllerRef, setup } = await renderReviewController([
      createAlphaFile(),
      createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const beta = 2;\n"),
      createDiffFile("gamma", "gamma.ts", "export const gamma = 1;\n", "export const gamma = 2;\n"),
      createDiffFile("delta", "delta.ts", "export const delta = 1;\n", "export const delta = 2;\n"),
    ]);

    try {
      await flush(setup);
      const initialAlignRequest = expectValue(controllerRef.current).selectedFileTopAlignRequestId;

      await act(async () => {
        expectValue(controllerRef.current).moveSelection("file", 3);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("delta.ts");
      expect(expectValue(controllerRef.current).selectedFileTopAlignRequestId).toBe(
        initialAlignRequest + 1,
      );
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
        expectValue(controllerRef.current).moveSelection("annotated-hunk", 1);
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
      { noteGeometry, stmlEnabled: true },
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
    const { controllerRef, setup } = await renderReviewController(
      [
        createDiffFile(
          "alpha",
          "alpha.ts",
          "export const alpha = 1;\n",
          "export const alpha = 2;\n",
        ),
      ],
      { stmlEnabled: true },
    );

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

  test("normal sessions reject STML live comments without mutating review state", async () => {
    const { controllerRef, setup } = await renderReviewController([createAlphaFile()]);

    try {
      await flush(setup);

      expect(() =>
        expectValue(controllerRef.current).addLiveComment(
          {
            filePath: "alpha.ts",
            side: "new",
            line: 1,
            summary: "Plain fallback",
            markup: "<badge>hidden</badge>",
          },
          "comment-disabled",
        ),
      ).toThrow("Relaunch Hunk with --experimental");
      expect(() =>
        expectValue(controllerRef.current).addLiveCommentBatch(
          [
            {
              filePath: "alpha.ts",
              hunkIndex: 0,
              summary: "Plain fallback",
              markup: "<badge>hidden</badge>",
            },
          ],
          "batch-disabled",
        ),
      ).toThrow("Relaunch Hunk with --experimental");

      expect(expectValue(controllerRef.current).liveCommentCount).toBe(0);
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

  test("the latest gap expansion receives the current line when one source load reveals two gaps", async () => {
    const deferred = createTestDeferred<string | null>();
    const sourceFetcher = createTestSourceFetcher(() => deferred.promise);
    const sourceLines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
    sourceLines[9] = "line 10 changed";
    sourceLines[39] = "line 40 changed";
    const { controllerRef, setup } = await renderReviewController([
      createTwoGapFile(sourceFetcher),
    ]);

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedFile?.metadata.hunks).toHaveLength(2);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
        expectValue(controllerRef.current).toggleGap("alpha", "before:1");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).sourceStatusByFileId.alpha?.kind).toBe("loading");
      expect(sourceFetcher.calls).toEqual(["new"]);

      deferred.resolve(lines(...sourceLines));
      await flush(setup);

      const controller = expectValue(controllerRef.current);
      expect(controller.expandedGapsByFileId.alpha?.has("before:0")).toBe(true);
      expect(controller.expandedGapsByFileId.alpha?.has("before:1")).toBe(true);
      expect(expectValue(controller.lineCursor).expandedGapKey).toBe("before:1");
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

  test("a soft reload that changed nothing keeps the reviewer's expanded gap open", async () => {
    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      createAlphaFile(createTestSourceFetcher(() => "first\n")),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      // Source identity is derived from content, so a reload that produced the same file
      // leaves everything derived from it valid — including what the reviewer expanded.
      await act(async () => {
        expectValue(setFilesRef.current)([
          createAlphaFile(createTestSourceFetcher(() => "first\n")),
        ]);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]?.kind).toBe("loaded");
      expect(
        expectValue(controllerRef.current).expandedGapsByFileId["alpha"]?.has("before:0"),
      ).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a soft reload that changed the file invalidates cached source and expansion", async () => {
    const firstFetcher = createTestSourceFetcher((side) => (side === "new" ? "first\n" : null));
    const secondFetcher = createTestSourceFetcher((side) => (side === "new" ? "second\n" : null));
    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      createAlphaFile(firstFetcher),
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

      // Simulate a soft reload: same file, changed content and a fresh fetcher.
      await act(async () => {
        expectValue(setFilesRef.current)([createReloadedAlphaFile(secondFetcher)]);
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
    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      createAlphaFile(firstFetcher),
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
        expectValue(setFilesRef.current)([createReloadedAlphaFile(secondFetcher)]);
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
    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      createAlphaFile(firstFetcher),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      await act(async () => {
        expectValue(setFilesRef.current)([createReloadedAlphaFile(secondFetcher)]);
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

  test("seeds the current line at the selected hunk so the indicator is visible on launch", async () => {
    const { controllerRef, setup } = await renderReviewController([createAlphaFile()]);

    try {
      await flush(setup);

      const cursor = expectValue(expectValue(controllerRef.current).lineCursor);
      expect(cursor.fileId).toBe("alpha");
      expect(cursor.hunkIndex).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("moves the current line one row at a time and clamps at the top of the stream", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);
      const first = expectValue(expectValue(controllerRef.current).lineCursor);

      await act(async () => {
        expectValue(controllerRef.current).moveLineCursor(1);
      });
      await flush(setup);
      const second = expectValue(expectValue(controllerRef.current).lineCursor);
      expect(second).not.toEqual(first);

      await act(async () => {
        expectValue(controllerRef.current).moveLineCursor(-1);
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).lineCursor).toEqual(first);

      await act(async () => {
        expectValue(controllerRef.current).moveLineCursor(-1);
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).lineCursor).toEqual(first);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("requests a reveal every time the current line moves", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);
      const initialRequestId = expectValue(controllerRef.current).lineCursorRevealRequestId;

      await act(async () => {
        expectValue(controllerRef.current).moveLineCursor(1);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).lineCursorRevealRequestId).toBe(
        initialRequestId + 1,
      );
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("moves several rendered lines with one reveal request", async () => {
    const file = createTwoHunkFile();
    const expectedCursors = buildLineCursors(
      [file],
      [
        measureDiffSectionGeometry(
          file,
          "stack",
          true,
          resolveTheme("github-dark-default", null),
          [],
          0,
          true,
          false,
        ),
      ],
    );
    const { controllerRef, setup } = await renderReviewController([file]);

    try {
      await flush(setup);
      const initial = expectValue(expectValue(controllerRef.current).lineCursor);
      const initialIndex = expectedCursors.findIndex(
        (cursor) => cursor.stableKey === initial.stableKey && cursor.fileId === initial.fileId,
      );
      const expected = expectValue(expectedCursors[initialIndex + 4]);
      const initialRequestId = expectValue(controllerRef.current).lineCursorRevealRequestId;

      await act(async () => {
        expectValue(controllerRef.current).moveLineCursor(4);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).lineCursor).toEqual(expected);
      expect(expectValue(controllerRef.current).lineCursorRevealRequestId).toBe(
        initialRequestId + 1,
      );
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("carries hunk selection along as the current line crosses a hunk boundary", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);

      for (let step = 0; step < 40; step += 1) {
        await act(async () => {
          expectValue(controllerRef.current).moveLineCursor(1);
        });
      }
      await flush(setup);

      const cursor = expectValue(expectValue(controllerRef.current).lineCursor);
      expect(cursor.hunkIndex).toBe(1);
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("moves the current line to the row a note is started on", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).startUserNote("alpha", 1, { side: "new", line: 12 });
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).lineCursor).toEqual({
        fileId: "alpha",
        hunkIndex: 1,
        stableKey: "line:1:new:12",
        target: { side: "new", line: 12 },
      });
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("moves across several hunks with one reveal request", async () => {
    const { controllerRef, setup } = await renderReviewController([createThreeHunkFile()]);

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedFile?.metadata.hunks).toHaveLength(3);
      const initialRequestId = expectValue(controllerRef.current).selectedHunkRevealRequestId;

      await act(async () => {
        expectValue(controllerRef.current).moveSelection("hunk", 2);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(2);
      expect(expectValue(expectValue(controllerRef.current).lineCursor).hunkIndex).toBe(2);
      expect(expectValue(controllerRef.current).selectedHunkRevealRequestId).toBe(
        initialRequestId + 1,
      );
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("carries the current line along when hunk navigation moves the selection", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);
      expect(expectValue(expectValue(controllerRef.current).lineCursor).hunkIndex).toBe(0);

      await act(async () => {
        expectValue(controllerRef.current).moveSelection("hunk", 1);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);
      expect(expectValue(expectValue(controllerRef.current).lineCursor).hunkIndex).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("recovers the current line when a reload retires the hunk it was on", async () => {
    const { controllerRef, setFilesRef, setup } = await renderReviewController([
      createTwoHunkFile(),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expectValue(controllerRef.current).selectHunk("alpha", 1);
      });
      await flush(setup);
      expect(expectValue(expectValue(controllerRef.current).lineCursor).hunkIndex).toBe(1);

      await act(async () => {
        expectValue(setFilesRef.current)([createSingleHunkFile()]);
      });
      await flush(setup);

      const cursor = expectValue(expectValue(controllerRef.current).lineCursor);
      expect(cursor.fileId).toBe("alpha");
      expect(cursor.hunkIndex).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("clears the line cursor while its selected file is filtered out", async () => {
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
      expect(expectValue(expectValue(controllerRef.current).lineCursor).fileId).toBe("alpha");

      await act(async () => {
        expectValue(controllerRef.current).setFilter("beta");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).lineCursor).toBeNull();

      await act(async () => {
        expectValue(controllerRef.current).clearFilter();
      });
      await flush(setup);

      expect(expectValue(expectValue(controllerRef.current).lineCursor).fileId).toBe("alpha");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
