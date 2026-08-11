import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { SourceTextTooLargeError } from "../../core/fileSource";
import { reviewGapAddress } from "../../core/review/expansion";
import { reviewDigest } from "../../core/review/identity";
import { planReviewIntent, type ReviewIntent } from "../../core/review/intents";
import { projectReviewNote } from "../../core/review/notes";
import { reviewLineContextDigest } from "../../core/review/reconcile";
import type { DiffFile } from "../../core/types";
import {
  createTestDeferred,
  createTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../../test/helpers/diff-helpers";
import { createTestReviewStore, replaceTestReviewStore } from "../../../test/helpers/review-store";
import {
  prepareReviewState,
  type ReviewStore,
  type ReviewStoreOptions,
} from "../../core/review/store";
import { measureDiffSectionGeometry } from "../diff/diffSectionGeometry";
import { buildLineCursors, type LineCursor } from "../lib/lineCursors";
import { resolveTheme } from "../themes";
import {
  useReviewController,
  type ReviewController,
  type ReviewIntentDispatcher,
} from "./useReviewController";

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

/** Build the small one-hunk alpha fixture used by general controller tests. */
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

/** Build one file with a canonical collapsed gap before its only hunk. */
function createExpandableAlphaFile(sourceFetcher?: DiffFile["sourceFetcher"]) {
  const beforeLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const afterLines = [...beforeLines];
  afterLines[9] = "line 10 changed";
  return createDiffFile(
    "alpha",
    "alpha.ts",
    lines(...beforeLines),
    lines(...afterLines),
    null,
    sourceFetcher,
  );
}

/** Model a partial deleted-file patch whose compact hunk still has expandable old-side source. */
function createDeletedSideExpandableAlphaFile(sourceFetcher?: DiffFile["sourceFetcher"]) {
  const file = createExpandableAlphaFile(sourceFetcher);
  // A complete deletion exposes every old line in its patch. Marking this synthetic fixture partial
  // models VCS adapters that intentionally provide only a compact deletion patch plus full source.
  return {
    ...file,
    metadata: { ...file.metadata, type: "deleted" as const, isPartial: true },
  };
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

/** Execute controller intents through the same pure plan and transactional store seam as runtime. */
function useTestReviewIntentDispatcher(store: ReviewStore): ReviewIntentDispatcher {
  const userNoteSequence = useRef(0);
  return useCallback(
    (intent: ReviewIntent) => {
      const before = store.getSnapshot();
      const pendingSequence =
        intent.type === "note/create-user" ? userNoteSequence.current + 1 : undefined;
      const timestamp = "2026-01-01T00:00:00.000Z";
      const plan = planReviewIntent(before, intent, {
        ...(pendingSequence === undefined
          ? {}
          : { noteId: `user:test-${pendingSequence}`, timestamp }),
        ...(intent.type === "note/update-user" ? { timestamp } : {}),
      });
      const prepared = prepareReviewState(before, plan.actions);
      const state = store.commitPrepared(before, prepared);
      if (pendingSequence !== undefined) userNoteSequence.current = pendingSequence;
      const createdId =
        plan.outcome?.type === "note/created" ? plan.outcome.note.note.id : undefined;
      const createdNote = createdId
        ? state.userNotes.find((entry) => entry.note.id === createdId)
        : undefined;
      return { state, ...(createdNote ? { createdNote } : {}) };
    },
    [store],
  );
}

function ReviewControllerHarness({
  initialFiles,
  onController,
  onMutationError,
  onSetFiles,
  validateNextSnapshot,
}: {
  initialFiles: DiffFile[];
  onController: (controller: ReviewController) => void;
  onMutationError?: (error: unknown) => void;
  onSetFiles?: (setFiles: (nextFiles: DiffFile[]) => void) => void;
  validateNextSnapshot?: ReviewStoreOptions["validateNextSnapshot"];
}) {
  const [authority, setAuthority] = useState(() => ({
    files: initialFiles,
    generation: 0,
    store: createTestReviewStore(initialFiles, { validateNextSnapshot }),
  }));
  const { files, store } = authority;
  const activeStore = useRef(store);
  activeStore.current = store;
  const sourceLoads = useRef(new Map<string, Promise<void>>());
  const toggleSourceGap = useCallback(
    (fileKey: string, gapId: string) => {
      const snapshot = store.getSnapshot();
      const semantic = snapshot.document.files.find((file) => file.key === fileKey);
      const file = semantic
        ? files.find((candidate) => candidate.id === semantic.runtimeId)
        : undefined;
      const side = file?.metadata.type === "deleted" ? "old" : "new";
      const sourceId = semantic?.sourceResourceIds[side];
      const source = snapshot.document.resources.find(
        (resource) => resource.id === sourceId && resource.kind === "source",
      );
      const address = semantic ? reviewGapAddress(semantic, gapId) : undefined;
      if (!semantic || !file?.sourceFetcher || !source || source.kind !== "source" || !address)
        return;
      const expanded = !snapshot.expandedGaps.some(
        (gap) => gap.fileKey === fileKey && gap.gapId === gapId && gap.expanded,
      );
      store.dispatch({
        type: "expansion/toggle",
        expectedGeneration: snapshot.documentGeneration,
        gap: {
          fileKey,
          gapId,
          side,
          ...address,
          sourceIdentity: source.sourceIdentity,
          expanded,
        },
      });
      if (!expanded) return;
      const status = store.getSnapshot().sourceStatusByFileKey[fileKey]?.kind;
      if (status === "loaded" || status === "loading") return;
      store.dispatch({
        type: "expansion/set-source-status",
        expectedGeneration: snapshot.documentGeneration,
        fileKey,
        status: { kind: "loading" },
      });
      const loadKey = `${snapshot.documentGeneration}:${fileKey}:${side}`;
      if (sourceLoads.current.has(loadKey)) return;
      const fetcher = file.sourceFetcher;
      const load = fetcher
        .getFullText(side)
        .then(
          (text) => {
            if (activeStore.current !== store) return;
            if (text !== null) {
              source.byteLength = Buffer.byteLength(text, "utf8");
              source.digest = reviewDigest(text);
            }
            store.dispatch({
              type: "expansion/set-source-status",
              expectedGeneration: snapshot.documentGeneration,
              fileKey,
              status: text === null ? { kind: "error" } : { kind: "loaded", text },
            });
          },
          (error: unknown) => {
            if (activeStore.current !== store) {
              console.error(
                `hunk: ignored stale ${side} source load failure for ${file.path} (${file.id}).`,
                error,
              );
              return;
            }
            if (!(error instanceof SourceTextTooLargeError)) {
              console.error(
                `hunk: failed to load ${side} source for ${file.path} (${file.id}).`,
                error,
              );
            }
            store.dispatch({
              type: "expansion/set-source-status",
              expectedGeneration: snapshot.documentGeneration,
              fileKey,
              status: {
                kind: "error",
                ...(error instanceof SourceTextTooLargeError
                  ? { reason: "too-large" as const }
                  : {}),
              },
            });
          },
        )
        .finally(() => sourceLoads.current.delete(loadKey));
      sourceLoads.current.set(loadKey, load);
    },
    [files, store],
  );
  const dispatchReviewIntent = useTestReviewIntentDispatcher(store);
  const [lineCursors, setLineCursors] = useState<LineCursor[]>([]);
  const controller = useReviewController({
    files,
    reviewStore: store,
    dispatchReviewIntent,
    lineCursors,
    onMutationError,
    toggleSourceGap,
  });
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
    onSetFiles?.((nextFiles) => {
      setAuthority((current) => {
        const generation = current.generation + 1;
        return {
          files: nextFiles,
          generation,
          store: replaceTestReviewStore(current.store, nextFiles, `generation:test:${generation}`),
        };
      });
    });
  }, [onSetFiles]);

  return null;
}

/** Render the controller hook and expose its latest state to tests. */
async function renderReviewController(
  initialFiles: DiffFile[],
  {
    onMutationError,
    strictMode = false,
    validateNextSnapshot,
  }: {
    onMutationError?: (error: unknown) => void;
    strictMode?: boolean;
    validateNextSnapshot?: ReviewStoreOptions["validateNextSnapshot"];
  } = {},
) {
  const controllerRef: { current: ReviewController | null } = { current: null };
  const setFilesRef: { current: ((nextFiles: DiffFile[]) => void) | null } = { current: null };
  const harness = (
    <ReviewControllerHarness
      initialFiles={initialFiles}
      onController={(nextController) => {
        controllerRef.current = nextController;
      }}
      onMutationError={onMutationError}
      onSetFiles={(nextSetFiles) => {
        setFilesRef.current = nextSetFiles;
      }}
      validateNextSnapshot={validateNextSnapshot}
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

  test("maps semantic files to terminal files by runtime identity across reorder", async () => {
    const alpha = createAlphaFile();
    const beta = createDiffFile(
      "beta",
      "beta.ts",
      "export const beta = 1;\n",
      "export const beta = 2;\n",
    );
    const { controllerRef, setFilesRef, setup } = await renderReviewController([alpha, beta]);

    try {
      await flush(setup);
      await act(async () => {
        const controller = expectValue(controllerRef.current);
        const snapshot = controller.store.getSnapshot();
        const semanticFile = snapshot.document.files.find((file) => file.runtimeId === "beta")!;
        controller.store.dispatch({
          type: "notes/add-live",
          expectedGeneration: snapshot.documentGeneration,
          notes: [
            {
              note: projectReviewNote({
                annotation: {
                  id: "live:beta",
                  source: "mcp",
                  newRange: [1, 1],
                  summary: "belongs to beta",
                },
                fileKey: semanticFile.key,
                hunks: beta.metadata.hunks,
                origin: "live-agent",
              }),
              contextDigest: reviewLineContextDigest(semanticFile, "new", 1),
              resolution: "active",
            },
          ],
        });
        controller.selectFile("beta");
        expectValue(setFilesRef.current)([
          { ...beta, id: "beta-reload" },
          { ...alpha, id: "alpha-reload" },
        ]);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("beta.ts");
      expect(
        expectValue(controllerRef.current).liveCommentsByFileId["beta-reload"]?.[0]?.summary,
      ).toBe("belongs to beta");
      expect(
        expectValue(controllerRef.current).liveCommentsByFileId["alpha-reload"],
      ).toBeUndefined();
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("renders independently rematched dual ranges after an asymmetric reload", async () => {
    const originalLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const changedLines = [...originalLines];
    changedLines[5] = "line 6 changed";
    const original = createDiffFile(
      "dual",
      "dual.ts",
      lines(...originalLines),
      lines(...changedLines),
    );
    const { controllerRef, setFilesRef, setup } = await renderReviewController([original]);

    try {
      await flush(setup);
      await act(async () => {
        const controller = expectValue(controllerRef.current);
        const snapshot = controller.store.getSnapshot();
        const semanticFile = snapshot.document.files[0]!;
        controller.store.dispatch({
          type: "notes/add-live",
          expectedGeneration: snapshot.documentGeneration,
          notes: [
            {
              note: projectReviewNote({
                annotation: {
                  id: "live:dual",
                  source: "mcp",
                  oldRange: [6, 7],
                  newRange: [6, 7],
                  summary: "dual range",
                },
                fileKey: semanticFile.key,
                hunks: original.metadata.hunks,
                origin: "live-agent",
              }),
              contextDigest: reviewLineContextDigest(semanticFile, "new", 6),
              contextDigests: {
                old: reviewLineContextDigest(semanticFile, "old", 6),
                new: reviewLineContextDigest(semanticFile, "new", 6),
              },
              resolution: "active",
            },
          ],
        });
        expectValue(setFilesRef.current)([
          createDiffFile(
            "dual-reload",
            "dual.ts",
            lines(...originalLines),
            lines("prefix 1", "prefix 2", "prefix 3", ...changedLines),
          ),
        ]);
      });
      await flush(setup);

      expect(
        expectValue(controllerRef.current).liveCommentsByFileId["dual-reload"]?.[0],
      ).toMatchObject({
        oldRange: [6, 7],
        newRange: [9, 10],
        side: "new",
        line: 9,
      });
    } finally {
      await act(async () => setup.renderer.destroy());
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

  test("moves across several files with one semantic selection and reveal", async () => {
    const { controllerRef, setup } = await renderReviewController([
      createAlphaFile(),
      createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const beta = 2;\n"),
      createDiffFile("gamma", "gamma.ts", "export const gamma = 1;\n", "export const gamma = 2;\n"),
      createDiffFile("delta", "delta.ts", "export const delta = 1;\n", "export const delta = 2;\n"),
    ]);

    try {
      await flush(setup);
      const controller = expectValue(controllerRef.current);
      const initialToken = controller.store.getSnapshot().reveal.fileTopToken;
      await act(async () => controller.moveToFile(3));
      await flush(setup);

      const next = expectValue(controllerRef.current);
      expect(next.selectedFile?.path).toBe("delta.ts");
      const state = next.store.getSnapshot();
      expect(state.document.files.find((file) => file.key === state.selection.fileKey)?.path).toBe(
        "delta.ts",
      );
      expect(state.selection.hunkIndex).toBe(0);
      expect(state.reveal.fileTopToken).toBe(initialToken + 1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("user note drafts can be saved and removed through terminal UI actions", async () => {
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
      const savedController = expectValue(controllerRef.current);
      expect(savedController.userNotesByFileId.alpha).toHaveLength(1);
      expect(savedController.store.getSnapshot().userNotes[0]).toMatchObject({
        note: {
          id: savedNoteId,
          source: "user",
          origin: "user",
          summary: "Please add a regression test.",
          editable: true,
          anchor: {
            preferred: { side: "new", line: 1 },
            ownerHunkIndex: 0,
            intersectingHunkIndices: [0],
          },
        },
        contextDigest: expect.any(String),
        contextDigests: { new: expect.any(String) },
        resolution: "active",
      });

      await act(async () => {
        expectValue(controllerRef.current).removeUserNote(savedNoteId);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).userNotesByFileId.alpha).toBeUndefined();
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a rejected terminal note save keeps its draft and surfaces the preflight failure", async () => {
    const errors: unknown[] = [];
    const { controllerRef, setup } = await renderReviewController([createAlphaFile()], {
      onMutationError: (error) => errors.push(error),
      validateNextSnapshot: (next) => {
        if (next.userNotes.length > 0) throw new Error("Review note exceeds broker bounds.");
      },
    });

    try {
      await flush(setup);
      await act(async () => {
        const controller = expectValue(controllerRef.current);
        controller.startUserNote("alpha", 0);
        controller.updateDraftNote("oversized terminal note");
      });
      await flush(setup);
      const controller = expectValue(controllerRef.current);
      const before = controller.store.getSnapshot();

      let saved: ReturnType<ReviewController["saveDraftNote"]> = null;
      await act(async () => {
        saved = expectValue(controllerRef.current).saveDraftNote();
      });
      await flush(setup);

      expect(saved).toBeNull();
      expect(expectValue(controllerRef.current).store.getSnapshot()).toBe(before);
      expect(expectValue(controllerRef.current).draftNote?.body).toBe("oversized terminal note");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect((errors[0] as Error).message).toBe("Review note exceeds broker bounds.");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("surfaces authority rejection for missing persisted notes without mutation", async () => {
    const errors: unknown[] = [];
    const { controllerRef, setup } = await renderReviewController([createAlphaFile()], {
      onMutationError: (error) => errors.push(error),
    });

    try {
      await flush(setup);
      const before = expectValue(controllerRef.current).store.getSnapshot();
      await act(async () => {
        expectValue(controllerRef.current).removeUserNote("user:missing");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).store.getSnapshot()).toBe(before);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain("No user note matches id user:missing");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("rapid duplicate saves persist exactly one user note with a unique id", async () => {
    const { controllerRef, setup } = await renderReviewController([createAlphaFile()]);
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

      expect(savedIds.first).toStartWith("user:");
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

      expect(savedIds.followUp).toStartWith("user:");
      expect(savedIds.followUp).not.toBe(savedIds.first);
      expect(expectValue(controllerRef.current).userNotesByFileId.alpha).toHaveLength(2);
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

    const { controllerRef, setup } = await renderReviewController([
      createExpandableAlphaFile(fakeFetcher),
    ]);

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

  test("selects and saves a draft on a proven expanded source line", async () => {
    const source = lines(...Array.from({ length: 10 }, (_, index) => `line ${index + 1}`));
    const fetcher = createTestSourceFetcher(() => source);
    const { controllerRef, setup } = await renderReviewController([
      createExpandableAlphaFile(fetcher),
    ]);

    try {
      await flush(setup);
      await act(async () => expectValue(controllerRef.current).toggleGap("alpha", "before:0"));
      await flush(setup);

      let controller = expectValue(controllerRef.current);
      const cursor = expectValue(controller.lineCursor);
      expect(cursor.expandedGapKey).toBe("before:0");
      const semanticSelection = controller.store.getSnapshot().selection;
      expect(semanticSelection).toMatchObject({
        hunkIndex: 0,
        side: "new",
        line: cursor.target.line,
        contextDigest: expect.any(String),
      });

      await act(async () => {
        controller.startUserNote("alpha", 0, cursor.target, { preserveViewport: true });
        expectValue(controllerRef.current).updateDraftNote("Expanded source rationale");
      });
      await flush(setup);
      controller = expectValue(controllerRef.current);
      const draft = expectValue(controller.draftNote);
      expect(draft.expandedLineProof).toMatchObject({ gapId: "before:0" });

      const result: { saved: ReturnType<ReviewController["saveDraftNote"]> } = { saved: null };
      await act(async () => {
        result.saved = expectValue(controllerRef.current).saveDraftNote();
      });
      await flush(setup);
      expect(result.saved?.summary).toBe("Expanded source rationale");
      expect(expectValue(controllerRef.current).store.getSnapshot().userNotes[0]).toMatchObject({
        contextDigest: semanticSelection.contextDigest,
        contextDigests: { new: semanticSelection.contextDigest },
      });
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("saves later-gap notes with their proven hunk owner", async () => {
    const sourceLines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
    sourceLines[9] = "line 10 changed";
    sourceLines[39] = "line 40 changed";
    const source = lines(...sourceLines);
    const { controllerRef, setup } = await renderReviewController([
      createTwoGapFile(createTestSourceFetcher(() => source)),
    ]);

    try {
      await flush(setup);
      await act(async () => expectValue(controllerRef.current).toggleGap("alpha", "before:1"));
      await flush(setup);
      const cursor = expectValue(expectValue(controllerRef.current).lineCursor);
      expect(cursor).toMatchObject({ hunkIndex: 1, expandedGapKey: "before:1" });

      await act(async () => {
        expectValue(controllerRef.current).startUserNote("alpha", 1, cursor.target, {
          preserveViewport: true,
        });
        expectValue(controllerRef.current).updateDraftNote("Later expanded rationale");
      });
      await flush(setup);
      await act(async () => {
        expectValue(controllerRef.current).saveDraftNote();
      });
      await flush(setup);

      expect(
        expectValue(controllerRef.current).store.getSnapshot().userNotes[0]?.note.anchor,
      ).toEqual({
        newRange: [cursor.target.line, cursor.target.line],
        preferred: { side: "new", line: cursor.target.line },
        intersectingHunkIndices: [],
        ownerHunkIndex: 1,
      });
      expect(expectValue(controllerRef.current).userNotesByFileId.alpha?.[0]).toMatchObject({
        hunkIndex: 1,
        summary: "Later expanded rationale",
      });
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("adopts a measured cursor in the same hunk after an external gap collapse", async () => {
    const sourceLines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
    sourceLines[9] = "line 10 changed";
    sourceLines[39] = "line 40 changed";
    const source = lines(...sourceLines);
    const { controllerRef, setup } = await renderReviewController([
      createTwoGapFile(createTestSourceFetcher(() => source)),
    ]);

    try {
      await flush(setup);
      await act(async () => expectValue(controllerRef.current).toggleGap("alpha", "before:1"));
      await flush(setup);
      let controller = expectValue(controllerRef.current);
      const expandedCursor = expectValue(controller.lineCursor);
      expect(expandedCursor).toMatchObject({ hunkIndex: 1, expandedGapKey: "before:1" });
      const expandedState = controller.store.getSnapshot();
      const gap = expandedState.expandedGaps.find(
        (candidate) =>
          candidate.fileKey === expandedState.selection.fileKey && candidate.gapId === "before:1",
      )!;

      await act(async () => {
        controller.store.dispatch({
          type: "expansion/toggle",
          expectedGeneration: expandedState.documentGeneration,
          gap: { ...gap, expanded: false },
        });
      });
      await flush(setup);

      controller = expectValue(controllerRef.current);
      const collapsedCursor = expectValue(controller.lineCursor);
      expect(collapsedCursor.fileId).toBe("alpha");
      expect(collapsedCursor.hunkIndex).toBe(1);
      expect(collapsedCursor.expandedGapKey).toBeUndefined();
      expect(collapsedCursor.stableKey).not.toBe(expandedCursor.stableKey);

      await act(async () => controller.moveLineCursor(1));
      await flush(setup);
      expect(expectValue(controllerRef.current).lineCursor).toMatchObject({
        fileId: "alpha",
        hunkIndex: 1,
      });
      expect(expectValue(controllerRef.current).store.getSnapshot().selection.hunkIndex).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("maps rendered expanded context to deleted-side source authority", async () => {
    const source = lines(...Array.from({ length: 10 }, (_, index) => `line ${index + 1}`));
    const fetcher = createTestSourceFetcher((side) => (side === "old" ? source : null));
    const { controllerRef, setup } = await renderReviewController([
      createDeletedSideExpandableAlphaFile(fetcher),
    ]);

    try {
      await flush(setup);
      await act(async () => expectValue(controllerRef.current).toggleGap("alpha", "before:0"));
      await flush(setup);

      let controller = expectValue(controllerRef.current);
      const cursor = expectValue(controller.lineCursor);
      expect(cursor.expandedGapKey).toBe("before:0");
      expect(cursor.target.side).toBe("new");
      expect(controller.store.getSnapshot().selection).toMatchObject({
        hunkIndex: 0,
        side: "old",
        line: 1,
        contextDigest: expect.any(String),
      });

      await act(async () => {
        controller.startUserNote("alpha", 0, cursor.target, { preserveViewport: true });
      });
      await flush(setup);
      controller = expectValue(controllerRef.current);
      expect(controller.draftNote).toMatchObject({
        side: "old",
        line: 1,
        oldRange: [1, 1],
        expandedLineProof: { gapId: "before:0" },
      });
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("retains an expanded-line draft when its proof is collapsed before save", async () => {
    const errors: unknown[] = [];
    const source = lines(...Array.from({ length: 10 }, (_, index) => `line ${index + 1}`));
    const fetcher = createTestSourceFetcher(() => source);
    const { controllerRef, setup } = await renderReviewController(
      [createExpandableAlphaFile(fetcher)],
      { onMutationError: (error) => errors.push(error) },
    );

    try {
      await flush(setup);
      await act(async () => expectValue(controllerRef.current).toggleGap("alpha", "before:0"));
      await flush(setup);
      const cursor = expectValue(expectValue(controllerRef.current).lineCursor);
      await act(async () => {
        expectValue(controllerRef.current).startUserNote("alpha", 0, cursor.target, {
          preserveViewport: true,
        });
        expectValue(controllerRef.current).updateDraftNote("Keep this draft");
      });
      await flush(setup);
      const before = expectValue(controllerRef.current).store.getSnapshot();
      const draftBefore = before.draftNote;

      await act(async () => expectValue(controllerRef.current).toggleGap("alpha", "before:0"));
      await flush(setup);
      const collapsed = expectValue(controllerRef.current).store.getSnapshot();
      expect(collapsed.draftNote).toBe(draftBefore);

      let saved: ReturnType<ReviewController["saveDraftNote"]> = null;
      await act(async () => {
        saved = expectValue(controllerRef.current).saveDraftNote();
      });
      await flush(setup);
      expect(saved).toBeNull();
      expect(expectValue(controllerRef.current).store.getSnapshot()).toBe(collapsed);
      expect(expectValue(controllerRef.current).store.getSnapshot().draftNote).toBe(draftBefore);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain("not backed by current canonical or expanded");
    } finally {
      await act(async () => setup.renderer.destroy());
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

  test("two batched toggles read store-current expansion state", async () => {
    const trackedFetcher = createTestSourceFetcher(() => lines(...Array(50).fill("source")));
    const { controllerRef, setup } = await renderReviewController([
      createTwoGapFile(trackedFetcher),
    ]);

    try {
      await flush(setup);
      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);
      expect(
        expectValue(controllerRef.current).expandedGapsByFileId["alpha"]?.has("before:0"),
      ).toBe(false);
      expect(trackedFetcher.calls).toEqual(["new"]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("toggleGap settles source status under React StrictMode", async () => {
    const deferred = createTestDeferred<string | null>();
    const fakeFetcher = createTestSourceFetcher(() => deferred.promise);

    const { controllerRef, setup } = await renderReviewController(
      [createExpandableAlphaFile(fakeFetcher)],
      { strictMode: true },
    );

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
    const { controllerRef, setup } = await renderReviewController([createExpandableAlphaFile()]);

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
      createExpandableAlphaFile(failingFetcher),
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
      createExpandableAlphaFile(failingFetcher),
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
      createExpandableAlphaFile(tooLargeFetcher),
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
      createExpandableAlphaFile(trackedFetcher),
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

  test("toggleGap rejects a noncanonical trailing gap for deleted files", async () => {
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

      expect(trackedFetcher.calls).toEqual([]);
      expect(expectValue(controllerRef.current).sourceStatusByFileId["removed"]).toBeUndefined();
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a soft reload preserves expansion but resets unproven source text", async () => {
    const firstFetcher = createTestSourceFetcher((side) => (side === "new" ? "first\n" : null));
    const secondFetcher = createTestSourceFetcher((side) => (side === "new" ? "second\n" : null));
    const baseFile = createExpandableAlphaFile();

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

      // Simulate a soft reload with a recreated fetcher for the same source identity.
      await act(async () => {
        expectValue(setFilesRef.current)([{ ...baseFile, sourceFetcher: secondFetcher }]);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]).toBeUndefined();
      expect(
        expectValue(controllerRef.current).expandedGapsByFileId["alpha"]?.has("before:0"),
      ).toBe(true);

      // Collapse does not fetch; reopening fetches the recreated source instead of stale text.
      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);

      expect(
        expectValue(controllerRef.current).expandedGapsByFileId["alpha"]?.has("before:0"),
      ).toBe(false);
      expect(secondFetcher.calls).toEqual([]);

      await act(async () => {
        expectValue(controllerRef.current).toggleGap("alpha", "before:0");
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).sourceStatusByFileId["alpha"]).toEqual({
        kind: "loaded",
        text: "second\n",
      });
      expect(secondFetcher.calls).toEqual(["new"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a pending source load cannot repopulate state after a soft reload", async () => {
    const firstLoad = createTestDeferred<string | null>();
    const firstFetcher = {
      ...createTestSourceFetcher(() => firstLoad.promise),
      cacheKey: "source:first",
    };
    const secondFetcher = {
      ...createTestSourceFetcher((side) => (side === "new" ? "second\n" : null)),
      cacheKey: "source:second",
    };
    const baseFile = createExpandableAlphaFile();

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
    const firstFetcher = {
      ...createTestSourceFetcher(() => firstLoad.promise),
      cacheKey: "source:first",
    };
    const secondFetcher = {
      ...createTestSourceFetcher((side) => (side === "new" ? "second\n" : null)),
      cacheKey: "source:second",
    };
    const baseFile = createExpandableAlphaFile();

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

  test("seeds the current line without publishing semantic state on launch", async () => {
    const { controllerRef, setup } = await renderReviewController([createAlphaFile()]);

    try {
      await flush(setup);

      const controller = expectValue(controllerRef.current);
      const cursor = expectValue(controller.lineCursor);
      expect(cursor.fileId).toBe("alpha");
      expect(cursor.hunkIndex).toBe(0);
      expect(controller.store.getSnapshot().stateRevision).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("adapts and reveals an external store line selection without local overwrite", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);
      const controller = expectValue(controllerRef.current);
      const initialRevealToken = controller.lineCursorRevealRequestId;
      const beforeRevision = controller.store.getSnapshot().stateRevision;
      const fileKey = controller.store.getSnapshot().document.files[0]!.key;
      await act(async () => {
        controller.store.dispatch({
          type: "selection/set-line",
          fileKey,
          hunkIndex: 1,
          side: "new",
          line: 12,
          contextDigest: "external-context",
          reveal: true,
        });
      });
      await flush(setup);

      expect(expectValue(expectValue(controllerRef.current).lineCursor)).toMatchObject({
        fileId: "alpha",
        hunkIndex: 1,
        target: { side: "new", line: 12 },
      });
      expect(expectValue(controllerRef.current).store.getSnapshot().selection).toMatchObject({
        fileKey,
        hunkIndex: 1,
        side: "new",
        line: 12,
      });
      expect(expectValue(controllerRef.current).lineCursorRevealRequestId).toBe(
        initialRevealToken + 1,
      );
      expect(expectValue(controllerRef.current).store.getSnapshot().stateRevision).toBe(
        beforeRevision + 1,
      );
    } finally {
      await act(async () => setup.renderer.destroy());
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

  test("moves several rendered lines with one semantic selection and reveal", async () => {
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
      const controller = expectValue(controllerRef.current);
      const initial = expectValue(controller.lineCursor);
      const initialIndex = expectedCursors.findIndex(
        (cursor) => cursor.stableKey === initial.stableKey && cursor.fileId === initial.fileId,
      );
      const expected = expectValue(expectedCursors[initialIndex + 4]);
      const initialToken = controller.store.getSnapshot().reveal.lineToken;
      const initialRevision = controller.store.getSnapshot().stateRevision;
      await act(async () => controller.moveLineCursor(4));
      await flush(setup);

      const next = expectValue(controllerRef.current);
      expect(next.lineCursor).toEqual(expected);
      const state = next.store.getSnapshot();
      expect(state.selection).toMatchObject({
        hunkIndex: expected.hunkIndex,
        side: expected.target.side,
        line: expected.target.line,
      });
      expect(state.reveal.lineToken).toBe(initialToken + 1);
      expect(state.stateRevision).toBe(initialRevision + 1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("moves across several hunks with one semantic selection and reveal", async () => {
    const { controllerRef, setup } = await renderReviewController([createThreeHunkFile()]);

    try {
      await flush(setup);
      const controller = expectValue(controllerRef.current);
      expect(controller.selectedFile?.metadata.hunks).toHaveLength(3);
      const initialToken = controller.store.getSnapshot().reveal.hunkToken;
      const initialRevision = controller.store.getSnapshot().stateRevision;
      await act(async () => controller.moveToHunk(2));
      await flush(setup);

      const next = expectValue(controllerRef.current);
      expect(next.selectedHunkIndex).toBe(2);
      expect(expectValue(next.lineCursor).hunkIndex).toBe(2);
      expect(next.store.getSnapshot().selection.hunkIndex).toBe(2);
      expect(next.store.getSnapshot().reveal.hunkToken).toBe(initialToken + 1);
      expect(next.store.getSnapshot().stateRevision).toBe(initialRevision + 1);
    } finally {
      await act(async () => setup.renderer.destroy());
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

  test("carries the current line along when hunk navigation moves the selection", async () => {
    const { controllerRef, setup } = await renderReviewController([createTwoHunkFile()]);

    try {
      await flush(setup);
      expect(expectValue(expectValue(controllerRef.current).lineCursor).hunkIndex).toBe(0);

      await act(async () => {
        expectValue(controllerRef.current).moveToHunk(1);
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

  test("re-seeds the current line into the file a filter leaves visible", async () => {
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

      expect(expectValue(expectValue(controllerRef.current).lineCursor).fileId).toBe("beta");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
