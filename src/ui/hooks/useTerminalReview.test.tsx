import { describe, expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useEffect, useRef, useState } from "react";
import { builtinAppCommand } from "../../core/run/commandCatalog";
import { SourceTextTooLargeError } from "../../core/changeset/fileSource";
import type { DiffFile } from "../../core/changeset/model";
import {
  createTestDeferred,
  createTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../../test/helpers/diff-helpers";
import { measureDiffSectionGeometry } from "../diff/diffSectionGeometry";
import { buildLineCursors, type LineCursor } from "../lib/lineCursors";
import { resolveTheme } from "../themes";
import { useTerminalReview, type TerminalReview } from "./useTerminalReview";

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
function createThreeHunkFile(id = "alpha", path = "alpha.ts") {
  const beforeLines = Array.from(
    { length: 30 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[0] = "export const line1 = 100;";
  afterLines[14] = "export const line15 = 1500;";
  afterLines[29] = "export const line30 = 3000;";

  return createDiffFile(id, path, lines(...beforeLines), lines(...afterLines));
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
/**
 * The alpha fixture: twelve lines with the eighth changed.
 *
 * Long enough that the parsed hunk leaves collapsed context on both sides of it, so the
 * file offers the real `before:0` and `trailing:0` gaps an expansion test can address.
 */
function createAlphaFile(sourceFetcher?: DiffFile["sourceFetcher"]) {
  const beforeLines = Array.from(
    { length: 12 },
    (_unused, index) => `export const alpha${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[7] = "export const alpha8 = 800;";
  return createDiffFile(
    "alpha",
    "alpha.ts",
    lines(...beforeLines),
    lines(...afterLines),
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
  const beforeLines = Array.from(
    { length: 12 },
    (_unused, index) => `export const alpha${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[7] = "export const alpha8 = 900;";
  return createDiffFile(
    "alpha",
    "alpha.ts",
    lines(...beforeLines),
    lines(...afterLines),
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

function TerminalReviewHarness({
  initialFiles,
  noteGeometry,
  publishLineCursors = true,
  stmlEnabled,
  onController,
  onFirstController,
  onSetFiles,
}: {
  initialFiles: DiffFile[];
  noteGeometry?: Parameters<typeof useTerminalReview>[0]["noteGeometry"];
  /** Publish measured stops, as the diff pane does unless the current-line marker is off. */
  publishLineCursors?: boolean;
  stmlEnabled?: boolean;
  onController: (controller: TerminalReview) => void;
  /** Receive the first render's controller, before any cursors were published. */
  onFirstController?: (controller: TerminalReview) => void;
  onSetFiles?: (setFiles: (nextFiles: DiffFile[]) => void) => void;
}) {
  const [files, setFiles] = useState(initialFiles);
  const [lineCursors, setLineCursors] = useState<LineCursor[]>([]);
  const controller = useTerminalReview({ files, lineCursors, noteGeometry, stmlEnabled });
  // Capture during render, as a memoized consumer's closure would: the effects
  // below have not yet published measured cursors on the first pass.
  const firstControllerRef = useRef<TerminalReview | null>(null);
  if (firstControllerRef.current === null) {
    firstControllerRef.current = controller;
    onFirstController?.(controller);
  }
  const visibleFiles = controller.visibleFiles;
  const { expandedGapsByFileId, sourceStatusByFileId } = controller;

  useEffect(() => {
    if (!publishLineCursors) {
      return;
    }

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
  }, [expandedGapsByFileId, publishLineCursors, sourceStatusByFileId, visibleFiles]);

  useEffect(() => {
    onController(controller);
  }, [controller, onController]);

  useEffect(() => {
    onSetFiles?.(setFiles);
  }, [onSetFiles]);

  return null;
}

/** Render the controller hook and expose its latest state to tests. */
async function renderTerminalReview(
  initialFiles: DiffFile[],
  {
    strictMode = false,
    noteGeometry,
    publishLineCursors,
    stmlEnabled,
    onFirstController,
  }: {
    strictMode?: boolean;
    noteGeometry?: Parameters<typeof useTerminalReview>[0]["noteGeometry"];
    publishLineCursors?: boolean;
    stmlEnabled?: boolean;
    onFirstController?: (controller: TerminalReview) => void;
  } = {},
) {
  const controllerRef: { current: TerminalReview | null } = { current: null };
  const setFilesRef: { current: ((nextFiles: DiffFile[]) => void) | null } = { current: null };
  const harness = (
    <TerminalReviewHarness
      initialFiles={initialFiles}
      noteGeometry={noteGeometry}
      publishLineCursors={publishLineCursors}
      stmlEnabled={stmlEnabled}
      onFirstController={onFirstController}
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

describe("useTerminalReview", () => {
  test("preserves a filtered-out selection until the reviewer clears the filter", async () => {
    const { controllerRef, setup } = await renderTerminalReview([
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
    const { controllerRef, setFilesRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const controllerRef: { current: TerminalReview | null } = { current: null };
    const setup = await testRender(
      <TerminalReviewHarness
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
    const { controllerRef, setup } = await renderTerminalReview([
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
    const { controllerRef, setup } = await renderTerminalReview([
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
    const { controllerRef, setup } = await renderTerminalReview(
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
    const { controllerRef, setup } = await renderTerminalReview(
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
    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile()]);

    try {
      await flush(setup);

      expect(() =>
        expectValue(controllerRef.current).addLiveComment(
          {
            filePath: "alpha.ts",
            side: "new",
            line: 8,
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
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const controllerRef: { current: TerminalReview | null } = { current: null };
    const setup = await testRender(
      <TerminalReviewHarness
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
    const controllerRef: { current: TerminalReview | null } = { current: null };
    const setup = await testRender(
      <TerminalReviewHarness
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
    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile()]);
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
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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

    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile(fakeFetcher)]);

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
    const { controllerRef, setup } = await renderTerminalReview([createTwoGapFile(sourceFetcher)]);

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

    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile(fakeFetcher)], {
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
    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile()]);

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

  // Intent: these three handlers execute the effect their catalog entry declares, rather
  // than a terminal restatement of it that could drift from what a browser palette or an
  // agent command lowering the same id would do.
  test("runs the review effect the catalog declares for the note layer, the nearest gap, and a new note", async () => {
    expect(builtinAppCommand("hunk.view.toggleAgentNotes").review).toEqual({
      kind: "notes/toggle-visibility",
    });
    expect(builtinAppCommand("hunk.review.toggleHunkGap").review).toEqual({
      kind: "expansion/toggle-selected-gap",
    });
    expect(builtinAppCommand("hunk.review.startNote").review).toEqual({
      kind: "notes/start-draft",
    });

    const beforeLines = Array.from(
      { length: 12 },
      (_, index) => `export const line${index + 1} = ${index + 1};`,
    );
    const afterLines = [...beforeLines];
    afterLines[0] = "export const line1 = 100;";
    afterLines[11] = "export const line12 = 1200;";
    const after = lines(...afterLines);
    const file = createDiffFile(
      "alpha",
      "alpha.ts",
      lines(...beforeLines),
      after,
      null,
      createTestSourceFetcher((side) => (side === "new" ? after : null)),
    );

    const { controllerRef, setup } = await renderTerminalReview([file]);

    try {
      await flush(setup);

      // A declared toggle, not a set: two invocations return the layer to where it started.
      await act(async () => {
        expectValue(controllerRef.current).toggleAgentNotes();
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).showAgentNotes).toBe(true);
      await act(async () => {
        expectValue(controllerRef.current).toggleAgentNotes();
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).showAgentNotes).toBe(false);

      // A note with no measured line lands on the shared whole-hunk default: the selected
      // hunk's first added line.
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);
      await act(async () => {
        expectValue(controllerRef.current).startUserNote();
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).draftNote).toMatchObject({
        fileId: "alpha",
        hunkIndex: 0,
        side: "new",
        line: 1,
      });
      await act(async () => {
        expectValue(controllerRef.current).cancelDraftNote();
      });
      await flush(setup);

      // The selected hunk opens the file, so it has no leading gap of its own and the
      // declared effect reaches forward to the next hunk's — the shared gap policy.
      await act(async () => {
        expectValue(controllerRef.current).toggleSelectedHunkGap();
      });
      await flush(setup);
      expect([...(expectValue(controllerRef.current).expandedGapsByFileId["alpha"] ?? [])]).toEqual(
        ["before:1"],
      );
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

    const { controllerRef, setup } = await renderTerminalReview([file]);

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

    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile(failingFetcher)]);

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

    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile(failingFetcher)]);

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

    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile(tooLargeFetcher)]);

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

    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile(trackedFetcher)]);

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

  // Intent: a fully deleted file's single hunk covers the whole file, so it has no
  // collapsed context anywhere — and a toggle is now validated against the same addressing
  // the renderer draws gaps from, rather than expanding a gap nobody could have clicked.
  test("toggleGap has nothing to expand on a fully deleted file", async () => {
    const trackedFetcher = createTestSourceFetcher((side) => (side === "old" ? "removed\n" : null));

    const { controllerRef, setup } = await renderTerminalReview([
      createDiffFile("removed", "removed.ts", "removed\n", "", null, trackedFetcher),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        expect(() => expectValue(controllerRef.current).toggleGap("removed", "trailing:0")).toThrow(
          "does not exist",
        );
      });
      await flush(setup);

      expect(trackedFetcher.calls).toEqual([]);
      expect(expectValue(controllerRef.current).sourceStatusByFileId["removed"]).toBeUndefined();
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a soft reload that changed nothing keeps the reviewer's expanded gap open", async () => {
    const { controllerRef, setFilesRef, setup } = await renderTerminalReview([
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
    const { controllerRef, setFilesRef, setup } = await renderTerminalReview([
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
    const { controllerRef, setFilesRef, setup } = await renderTerminalReview([
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
    const { controllerRef, setFilesRef, setup } = await renderTerminalReview([
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
    const { controllerRef, setup } = await renderTerminalReview([createAlphaFile()]);

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
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

    try {
      await flush(setup);
      const initialRequestId = expectValue(controllerRef.current).lineCursorRevealRequest.id;

      await act(async () => {
        expectValue(controllerRef.current).moveLineCursor(1);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).lineCursorRevealRequest).toEqual({
        id: initialRequestId + 1,
        placement: "nearest",
      });
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
    const { controllerRef, setup } = await renderTerminalReview([file]);

    try {
      await flush(setup);
      const initial = expectValue(expectValue(controllerRef.current).lineCursor);
      const initialIndex = expectedCursors.findIndex(
        (cursor) => cursor.stableKey === initial.stableKey && cursor.fileId === initial.fileId,
      );
      const expected = expectValue(expectedCursors[initialIndex + 4]);
      const initialRequestId = expectValue(controllerRef.current).lineCursorRevealRequest.id;

      await act(async () => {
        expectValue(controllerRef.current).moveLineCursor(4);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).lineCursor).toEqual(expected);
      expect(expectValue(controllerRef.current).lineCursorRevealRequest).toEqual({
        id: initialRequestId + 1,
        placement: "nearest",
      });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("carries hunk selection along as the current line crosses a hunk boundary", async () => {
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const { controllerRef, setup } = await renderTerminalReview([createThreeHunkFile()]);

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
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const { controllerRef, setFilesRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

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
    const { controllerRef, setup } = await renderTerminalReview([
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

  test("reveals one line of another file and asks for the reveal placement", async () => {
    // Cursors are measured for every visible file, so a cross-file jump resolves in the same
    // pass as a local one — no pending second reveal once the target file renders.
    const { controllerRef, setup } = await renderTerminalReview([
      createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\n"),
      createThreeHunkFile("beta", "beta.ts"),
    ]);

    try {
      await flush(setup);
      const before = expectValue(controllerRef.current).lineCursorRevealRequest;
      expect(expectValue(expectValue(controllerRef.current).lineCursor).fileId).toBe("alpha");

      let outcome: string | undefined;
      await act(async () => {
        outcome = expectValue(controllerRef.current).revealLine("beta", "new", 30);
      });
      await flush(setup);

      expect(outcome).toBe("line");
      expect(expectValue(controllerRef.current).lineCursor).toMatchObject({
        fileId: "beta",
        hunkIndex: 2,
        target: { side: "new", line: 30 },
      });
      // Selection follows the revealed line so notes and hunk actions stay on the same target.
      expect(expectValue(controllerRef.current).selectedFileId).toBe("beta");
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(2);
      expect(expectValue(controllerRef.current).lineCursorRevealRequest).toEqual({
        id: before.id + 1,
        placement: "reveal",
      });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("jumps precisely even when the pane publishes no line stops", async () => {
    // With the current-line marker off the pane publishes no stops, but the target row is
    // still measured: the reveal synthesizes the line's cursor and lands exactly on it.
    const { controllerRef, setup } = await renderTerminalReview([createThreeHunkFile()], {
      publishLineCursors: false,
    });

    try {
      await flush(setup);
      const before = expectValue(controllerRef.current).lineCursorRevealRequest;

      let outcome: string | undefined;
      await act(async () => {
        outcome = expectValue(controllerRef.current).revealLine("alpha", "new", 15);
      });
      await flush(setup);

      expect(outcome).toBe("line");
      expect(expectValue(controllerRef.current).lineCursor).toMatchObject({
        fileId: "alpha",
        hunkIndex: 1,
        target: { side: "new", line: 15 },
      });
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);
      expect(expectValue(controllerRef.current).lineCursorRevealRequest.id).toBe(before.id + 1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a revealLine reference held from before cursors were measured still lands the line", async () => {
    // A memoized extension pane keeps its mount-time `actions`, whose
    // `revealLine` was minted on the first render — before the diff pane's
    // effect published any measured cursors. That held reference must read the
    // stops live: the session's first deferred search jump used to silently
    // degrade to the hunk fallback because its closure still saw the empty
    // pre-measurement list.
    const firstControllerRef: { current: TerminalReview | null } = { current: null };
    const { controllerRef, setup } = await renderTerminalReview([createThreeHunkFile()], {
      onFirstController: (controller) => {
        firstControllerRef.current = controller;
      },
    });

    try {
      await flush(setup);
      // The captured instance predates the cursor publication…
      const first = expectValue(firstControllerRef.current);
      // …while the current instance has long since seen the measured stops.
      expect(expectValue(controllerRef.current).lineCursor).not.toBeNull();

      let outcome: string | undefined;
      await act(async () => {
        outcome = first.revealLine("alpha", "new", 30);
      });
      await flush(setup);

      expect(outcome).toBe("line");
      expect(expectValue(controllerRef.current).lineCursor).toMatchObject({
        fileId: "alpha",
        hunkIndex: 2,
        target: { side: "new", line: 30 },
      });
      expect(expectValue(controllerRef.current).lineCursorRevealRequest.placement).toBe("reveal");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("reports a line no hunk of the file covers instead of moving the review", async () => {
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

    try {
      await flush(setup);

      let outcome: string | undefined;
      await act(async () => {
        outcome = expectValue(controllerRef.current).revealLine("alpha", "new", 9001);
      });
      await flush(setup);

      expect(outcome).toBe("none");
      expect(expectValue(expectValue(controllerRef.current).lineCursor).hunkIndex).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("paints one validated agent attention mark and reveals its line on focus", async () => {
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

    try {
      await flush(setup);
      const before = expectValue(controllerRef.current).lineCursorRevealRequest;

      let result: ReturnType<TerminalReview["addAgentLineHighlight"]> | undefined;
      await act(async () => {
        result = expectValue(controllerRef.current).addAgentLineHighlight({
          filePath: "alpha.ts",
          side: "new",
          line: 12,
          start: 0,
          end: 6,
          tone: "warning",
          reveal: true,
        });
      });
      await flush(setup);

      expect(result).toMatchObject({
        fileId: "alpha",
        filePath: "alpha.ts",
        hunkIndex: 1,
        side: "new",
        line: 12,
        start: 0,
        end: 6,
        tone: "warning",
        fileMarkCount: 1,
        revealed: "line",
      });
      // The mark is retained in the same validated shape the paint pipeline consumes.
      expect(expectValue(controllerRef.current).agentLineHighlightsByFileId.get("alpha")).toEqual([
        { side: "new", line: 12, start: 0, end: 6, tone: "warning" },
      ]);
      // Focus rode the shared reveal path: line cursor on the marked row, reveal placement.
      expect(expectValue(controllerRef.current).lineCursor).toMatchObject({
        fileId: "alpha",
        target: { side: "new", line: 12 },
      });
      expect(expectValue(controllerRef.current).lineCursorRevealRequest).toEqual({
        id: before.id + 1,
        placement: "reveal",
      });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("defaults agent marks to the match tone without moving the viewport", async () => {
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

    try {
      await flush(setup);
      const before = expectValue(controllerRef.current).lineCursorRevealRequest;

      let result: ReturnType<TerminalReview["addAgentLineHighlight"]> | undefined;
      await act(async () => {
        result = expectValue(controllerRef.current).addAgentLineHighlight({
          filePath: "alpha.ts",
          side: "new",
          line: 1,
          start: 13,
          end: 18,
        });
      });
      await flush(setup);

      expect(result).toMatchObject({ tone: "match", hunkIndex: 0, fileMarkCount: 1 });
      expect(result?.revealed).toBeUndefined();
      expect(expectValue(controllerRef.current).lineCursorRevealRequest.id).toBe(before.id);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("rejects agent marks on unknown files, uncovered lines, and empty ranges", async () => {
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

    try {
      await flush(setup);
      const controller = expectValue(controllerRef.current);

      expect(() =>
        controller.addAgentLineHighlight({
          filePath: "missing.ts",
          side: "new",
          line: 1,
          start: 0,
          end: 4,
        }),
      ).toThrow("No diff file matches missing.ts.");
      expect(() =>
        controller.addAgentLineHighlight({
          filePath: "alpha.ts",
          side: "new",
          line: 9001,
          start: 0,
          end: 4,
        }),
      ).toThrow("No new diff hunk in alpha.ts covers line 9001.");
      // Empty and inverted ranges fail the same structural validation extension marks pass through.
      expect(() =>
        controller.addAgentLineHighlight({
          filePath: "alpha.ts",
          side: "new",
          line: 1,
          start: 4,
          end: 4,
        }),
      ).toThrow("Highlight range [4, 4) is not a valid [start, end) character range.");

      await flush(setup);
      expect(expectValue(controllerRef.current).agentLineHighlightsByFileId.size).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("clears agent marks per file and globally with honest counts", async () => {
    const { controllerRef, setup } = await renderTerminalReview([
      createTwoHunkFile(),
      createThreeHunkFile("beta", "beta.ts"),
    ]);

    try {
      await flush(setup);

      await act(async () => {
        const controller = expectValue(controllerRef.current);
        controller.addAgentLineHighlight({
          filePath: "alpha.ts",
          side: "new",
          line: 1,
          start: 0,
          end: 4,
        });
        controller.addAgentLineHighlight({
          filePath: "alpha.ts",
          side: "new",
          line: 12,
          start: 0,
          end: 4,
        });
        controller.addAgentLineHighlight({
          filePath: "beta.ts",
          side: "new",
          line: 1,
          start: 0,
          end: 4,
        });
      });
      await flush(setup);

      let cleared: ReturnType<TerminalReview["clearAgentLineHighlights"]> | undefined;
      await act(async () => {
        cleared = expectValue(controllerRef.current).clearAgentLineHighlights("alpha.ts");
      });
      await flush(setup);
      expect(cleared).toEqual({ removedCount: 2, remainingCount: 1, filePath: "alpha.ts" });
      expect(expectValue(controllerRef.current).agentLineHighlightsByFileId.has("alpha")).toBe(
        false,
      );

      await act(async () => {
        cleared = expectValue(controllerRef.current).clearAgentLineHighlights();
      });
      await flush(setup);
      expect(cleared).toEqual({ removedCount: 1, remainingCount: 0 });
      expect(expectValue(controllerRef.current).agentLineHighlightsByFileId.size).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a reload keeps agent attention marks on files whose content is unchanged", async () => {
    // A refresh that finds nothing changed on disk still rebuilds the file list, and the marks
    // it carries still name the same characters, so they survive and re-key onto the new ids.
    const { controllerRef, setFilesRef, setup } = await renderTerminalReview([createAlphaFile()]);

    try {
      await flush(setup);
      await act(async () => {
        expectValue(controllerRef.current).addAgentLineHighlight({
          filePath: "alpha.ts",
          side: "new",
          line: 8,
          start: 0,
          end: 6,
        });
      });
      await flush(setup);
      expect([...expectValue(controllerRef.current).agentLineHighlightsByFileId.keys()]).toEqual([
        "alpha",
      ]);

      await act(async () => {
        // Same path and content, rebuilt under a new runtime id, as a reload produces.
        expectValue(setFilesRef.current)([{ ...createAlphaFile(), id: "alpha-reloaded" }]);
      });
      await flush(setup);

      const marks = expectValue(controllerRef.current).agentLineHighlightsByFileId;
      expect([...marks.keys()]).toEqual(["alpha-reloaded"]);
      expect(marks.get("alpha-reloaded")).toEqual([
        { side: "new", line: 8, start: 0, end: 6, tone: "match" },
      ]);

      let cleared: ReturnType<TerminalReview["clearAgentLineHighlights"]> | undefined;
      await act(async () => {
        cleared = expectValue(controllerRef.current).clearAgentLineHighlights();
      });
      expect(cleared).toEqual({ removedCount: 1, remainingCount: 0 });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a session reload clears agent attention marks on files whose content changed", async () => {
    // Marks address exact character offsets; after a reload nothing re-derives them the way
    // extension highlighters re-run, so a stale mark would light up different text.
    const { controllerRef, setFilesRef, setup } = await renderTerminalReview([createAlphaFile()]);

    try {
      await flush(setup);
      await act(async () => {
        expectValue(controllerRef.current).addAgentLineHighlight({
          filePath: "alpha.ts",
          side: "new",
          line: 8,
          start: 0,
          end: 6,
        });
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).agentLineHighlightsByFileId.size).toBe(1);

      await act(async () => {
        expectValue(setFilesRef.current)([createReloadedAlphaFile()]);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).agentLineHighlightsByFileId.size).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("navigate line targets land the viewport on the exact line", async () => {
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()]);

    try {
      await flush(setup);
      const before = expectValue(controllerRef.current).lineCursorRevealRequest;

      let result: ReturnType<TerminalReview["navigateToLocation"]> | undefined;
      await act(async () => {
        result = expectValue(controllerRef.current).navigateToLocation({
          filePath: "alpha.ts",
          side: "new",
          line: 12,
        });
      });
      await flush(setup);

      expect(result).toMatchObject({
        fileId: "alpha",
        filePath: "alpha.ts",
        hunkIndex: 1,
        revealed: "line",
        side: "new",
        line: 12,
      });
      expect(expectValue(controllerRef.current).lineCursor).toMatchObject({
        fileId: "alpha",
        target: { side: "new", line: 12 },
      });
      // The same reveal placement extensions get from ctx.navigation.revealLine.
      expect(expectValue(controllerRef.current).lineCursorRevealRequest).toEqual({
        id: before.id + 1,
        placement: "reveal",
      });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("navigate line targets land precisely when the pane publishes no stops", async () => {
    const { controllerRef, setup } = await renderTerminalReview([createTwoHunkFile()], {
      publishLineCursors: false,
    });

    try {
      await flush(setup);

      let result: ReturnType<TerminalReview["navigateToLocation"]> | undefined;
      await act(async () => {
        result = expectValue(controllerRef.current).navigateToLocation({
          filePath: "alpha.ts",
          side: "new",
          line: 12,
        });
      });
      await flush(setup);

      expect(result).toMatchObject({ hunkIndex: 1, revealed: "line" });
      expect(expectValue(controllerRef.current).lineCursor).toMatchObject({
        fileId: "alpha",
        target: { side: "new", line: 12 },
      });
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
