/**
 * The shared intent planner as a navigation conformance consumer.
 *
 * Everything is read back through `planReviewIntent` — the same entry point the terminal's
 * keyboard, the session's comment navigation, and later the wire all go through — rather
 * than by calling the walk directly, so a planner that stopped consulting the shared
 * selectors would show up here.
 */
import { projectReviewDocument } from "../../../packages/hunk/src/core/review/document";
import { planReviewIntent } from "../../../packages/hunk/src/core/review/intents";
import type { ReviewAnnotationIndex } from "../../../packages/hunk/src/core/review/navigation";
import {
  selectNormalizedSelection,
  selectRevealTarget,
} from "../../../packages/hunk/src/core/review/selectors";
import {
  createInitialReviewState,
  type ReviewState,
} from "../../../packages/hunk/src/core/review/state";
import type { ReviewDocumentV1 } from "../../../packages/hunk/src/core/review/types";
import type {
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

export const intentPlannerNavigationConsumer: ReviewNavigationConsumer = {
  name: "core intent planner",
  phase: "Phase 1 PR 3",
  project(fixture: ReviewNavigationFixture) {
    const document = projectReviewDocument(fixture.build());
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
        const plan = planReviewIntent(
          stateAt(move.from),
          { type: "selection/move", scope: move.scope, delta: move.delta },
          { annotations },
        );
        const action = plan.actions[0];
        if (!action || action.type !== "selection/select" || !action.reveal) {
          return { to: null };
        }
        return {
          to: toConformanceSelection(action.fileKey, action.hunkIndex, document),
          reveal: action.reveal,
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
