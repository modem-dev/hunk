/**
 * The terminal review controller as a navigation conformance consumer.
 *
 * The controller submits relative moves through `applyReviewIntent` and reconciles its
 * rendered selection after document/filter updates. This adapter drives those same two
 * planning paths without mounting OpenTUI, so the shared corpus catches a terminal
 * lifecycle regression as well as a core-planner regression.
 */
import type { ReviewAction } from "../../../packages/hunk/src/core/review/actions";
import { projectReviewDocument } from "../../../packages/hunk/src/core/review/document";
import { applyReviewIntent } from "../../../packages/hunk/src/core/review/intents";
import { reduceReviewState } from "../../../packages/hunk/src/core/review/reducer";
import { selectRevealTarget } from "../../../packages/hunk/src/core/review/selectors";
import {
  createInitialReviewState,
  type ReviewState,
} from "../../../packages/hunk/src/core/review/state";
import type { ReviewStore } from "../../../packages/hunk/src/core/review/store";
import { planTerminalSelectionReconciliation } from "../../../packages/hunk/src/ui/lib/reviewState";
import { toAnnotationIndex, toConformanceSelection, toSemanticSelection } from "./intentPlanner";
import type { ReviewNavigationConsumer, ReviewNavigationFixture } from "../types";

/** Apply the terminal's render-lifecycle reconciliation without requesting a reveal. */
function reconcileTerminalSelection(state: ReviewState) {
  const action = planTerminalSelectionReconciliation(state);
  return action ? reduceReviewState(state, action) : state;
}

/** Build the minimal synchronous store the controller's `runIntent` helper receives. */
function createTestReviewStore(initial: ReviewState): ReviewStore {
  let snapshot = initial;
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    dispatch(action: ReviewAction) {
      snapshot = reduceReviewState(snapshot, action);
      return snapshot;
    },
  };
}

/** Recover the semantic reveal request from the counters the store published. */
function revealFromTransition(before: ReviewState, after: ReviewState) {
  return {
    anchor:
      after.reveal.fileTopToken !== before.reveal.fileTopToken
        ? ("file-top" as const)
        : after.reveal.hunkToken !== before.reveal.hunkToken
          ? ("hunk" as const)
          : ("none" as const),
    scrollToNote: after.reveal.scrollToNote,
  };
}

export const terminalReviewNavigationConsumer: ReviewNavigationConsumer = {
  name: "terminal review",
  phase: "Phase 1 PR 3",
  project(fixture: ReviewNavigationFixture) {
    const document = projectReviewDocument(fixture.build());
    const annotations = toAnnotationIndex(fixture, document);
    const baseState: ReviewState = {
      ...createInitialReviewState(document),
      filter: fixture.filter ?? "",
    };
    const stateAt = (input: ReviewNavigationFixture["selections"][number]) =>
      reconcileTerminalSelection({
        ...baseState,
        selection: toSemanticSelection(input, document),
      });

    return {
      moves: fixture.moves.map((move) => {
        // This is the same semantic-intent call `useTerminalReview` makes for its
        // keyboard and session navigation handlers.
        const store = createTestReviewStore(stateAt(move.from));
        const before = store.getSnapshot();
        const outcome = applyReviewIntent(
          store,
          { type: "selection/move", scope: move.scope, delta: move.delta },
          { annotations },
        );
        if (!outcome) {
          return { to: null };
        }
        const after = store.getSnapshot();
        return {
          to: toConformanceSelection(after.selection.fileKey, after.selection.hunkIndex, document),
          reveal: revealFromTransition(before, after),
        };
      }),
      normalizedSelections: fixture.selections.map((input) => {
        const selection = stateAt(input).selection;
        return toConformanceSelection(selection.fileKey, selection.hunkIndex, document);
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
