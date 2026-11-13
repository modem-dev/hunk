/**
 * The shared intent planner as a navigation conformance consumer.
 *
 * Everything is read back through `planReviewIntent` — the same entry point the terminal's
 * keyboard, the session's comment navigation, and later the wire all go through — rather
 * than by calling the walk directly, so a planner that stopped consulting the shared
 * selectors would show up here.
 */
import { projectReviewDocument } from "../../../packages/hunk/src/core/review/document";
import { buildReviewThreadCursors } from "../../../packages/hunk/src/core/review/annotations";
import {
  planReviewIntent,
  type ReviewIntentFacts,
} from "../../../packages/hunk/src/core/review/intents";
import type {
  ReviewAnnotationIndex,
  ReviewMoveLanding,
} from "../../../packages/hunk/src/core/review/navigation";
import {
  selectNormalizedSelection,
  selectRevealTarget,
  selectStoredThreadRoots,
  selectVisibleReviewFiles,
} from "../../../packages/hunk/src/core/review/selectors";
import type { DiffFile } from "../../../packages/hunk/src/core/changeset/model";
import {
  createInitialReviewState,
  type ReviewState,
} from "../../../packages/hunk/src/core/review/state";
import type { ReviewDocumentV1 } from "../../../packages/hunk/src/core/review/types";
import type {
  ConformanceLanding,
  ConformanceMove,
  ConformanceSelection,
  ConformanceSelectionInput,
  ReviewNavigationConsumer,
  ReviewNavigationFixture,
} from "../types";

/** A key no projected document can produce, standing in for a file a reload dropped. */
export const VANISHED_FILE_KEY = "vanished:no-such-file";

/** Resolve a fixture's positional selection into the semantic one core reads. */
export function toSemanticSelection(input: ConformanceSelectionInput, document: ReviewDocumentV1) {
  if (input.file === null) {
    return { fileKey: null, hunkIndex: input.hunkIndex };
  }
  if (input.file === "vanished") {
    return { fileKey: VANISHED_FILE_KEY, hunkIndex: input.hunkIndex };
  }
  return {
    fileKey: document.files[input.file]?.key ?? VANISHED_FILE_KEY,
    hunkIndex: input.hunkIndex,
  };
}

/** Report a semantic position back as the file index the fixture states. */
export function toConformanceSelection(
  fileKey: string | null,
  hunkIndex: number,
  document: ReviewDocumentV1,
): ConformanceSelection {
  const index = document.files.findIndex((file) => file.key === fileKey);
  return { file: index < 0 ? null : index, hunkIndex };
}

/** Build the annotation index the fixture declares, keyed by semantic file key. */
export function toAnnotationIndex(
  fixture: ReviewNavigationFixture,
  document: ReviewDocumentV1,
): ReviewAnnotationIndex {
  const annotatedHunks = Object.entries(fixture.annotatedHunks ?? {});
  const annotatedHunkIndicesByFileKey = new Map(
    annotatedHunks.flatMap(([fileIndex, hunkIndices]) => {
      const file = document.files[Number(fileIndex)];
      return file ? [[file.key, new Set(hunkIndices)] as const] : [];
    }),
  );
  const annotatedFileIndices =
    fixture.annotatedFiles ?? annotatedHunks.map(([fileIndex]) => Number(fileIndex));
  return {
    annotatedHunkIndicesByFileKey,
    annotatedFileKeys: new Set(
      annotatedFileIndices.flatMap((fileIndex) => {
        const file = document.files[fileIndex];
        return file ? [file.key] : [];
      }),
    ),
  };
}

/**
 * Supply the caller-owned facts one move needs.
 *
 * Within-hunk scopes get the reviewer's position inside `from`'s hunk and the thread stops,
 * built from the fixture's sidecar annotations and stored roots through the same builder
 * the terminal and producer use.
 */
export function toMoveFacts(
  move: ConformanceMove,
  state: ReviewState,
  files: readonly DiffFile[],
  annotations: ReviewAnnotationIndex,
): ReviewIntentFacts {
  const facts: ReviewIntentFacts = { annotations };
  if (move.scope !== "change-block" && move.scope !== "comment-thread") {
    return facts;
  }

  const { fileKey, hunkIndex } = state.selection;
  if (fileKey !== null) {
    facts.focus = { fileKey, hunkIndex, ...(move.focusLine ? { line: move.focusLine } : {}) };
  }
  const sidecarByRuntimeId = new Map(files.map((file) => [file.id, file.agent?.annotations]));
  facts.threads = buildReviewThreadCursors({
    files: selectVisibleReviewFiles(state).map((file) => ({
      fileKey: file.key,
      hunks: file.hunks,
      sidecar: sidecarByRuntimeId.get(file.runtimeId) ?? [],
    })),
    storedRoots: selectStoredThreadRoots(state),
    showAgentNotes: state.showAgentNotes,
  });
  return facts;
}

/** Report a within-hunk landing in the fixture's renderer-neutral shape. */
export function toConformanceLanding(landing: ReviewMoveLanding | undefined): {
  landing?: ConformanceLanding;
} {
  if (!landing) {
    return {};
  }
  return landing.kind === "change-block"
    ? { landing: { kind: "change-block", line: landing.block.line } }
    : { landing: { kind: "comment-thread", threadKind: landing.threadKind, line: landing.line } };
}

export const intentPlannerNavigationConsumer: ReviewNavigationConsumer = {
  name: "core intent planner",
  phase: "Phase 1 PR 3",
  project(fixture: ReviewNavigationFixture) {
    const files = fixture.build();
    const document = projectReviewDocument(files);
    const annotations = toAnnotationIndex(fixture, document);
    const baseState: ReviewState = {
      ...createInitialReviewState(document),
      filter: fixture.filter ?? "",
    };
    const stateAt = (input: ConformanceSelectionInput) => ({
      ...baseState,
      selection: toSemanticSelection(input, document),
    });

    return {
      moves: fixture.moves.map((move) => {
        const state = stateAt(move.from);
        const plan = planReviewIntent(
          state,
          { type: "selection/move", scope: move.scope, delta: move.delta },
          toMoveFacts(move, state, files, annotations),
        );
        const action = plan.actions[0];
        if (!action || action.type !== "selection/select" || !action.reveal) {
          return { to: null };
        }
        return {
          to: toConformanceSelection(action.fileKey, action.hunkIndex, document),
          reveal: action.reveal,
          ...toConformanceLanding(
            plan.outcome?.type === "selection/changed" ? plan.outcome.landing : undefined,
          ),
        };
      }),
      normalizedSelections: fixture.selections.map((input) => {
        const normalized = selectNormalizedSelection(stateAt(input));
        return toConformanceSelection(normalized.fileKey, normalized.hunkIndex, document);
      }),
      revealTargets: document.files.map((file, fileIndex) =>
        file.hunks.map(
          (_hunk, hunkIndex) =>
            selectRevealTarget({
              ...baseState,
              selection: toSemanticSelection({ file: fileIndex, hunkIndex }, document),
            }) ?? null,
        ),
      ),
    };
  },
};
