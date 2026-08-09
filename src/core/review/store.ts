import type { ReviewAction } from "./actions";
import { reduceReviewState } from "./reducer";
import { createInitialReviewState, type ReviewState } from "./state";
import type { ReviewDocumentV1 } from "./types";

export interface ReviewStore {
  getSnapshot(): ReviewState;
  subscribe(listener: () => void): () => void;
  dispatch(action: ReviewAction): ReviewState;
  /** Commit an already validated state only if its source snapshot is still current. */
  commitPrepared(expected: ReviewState, next: ReviewState): ReviewState;
}

export interface ReviewStoreOptions {
  /** Reject a prospective revision before it becomes observable or authoritative. */
  validateNextSnapshot?: (next: ReviewState, previous: ReviewState) => void;
}

/** Reduce several semantic actions into one prospective revision without publishing. */
export function prepareReviewState(state: ReviewState, actions: readonly ReviewAction[]) {
  let reduced = state;
  for (const action of actions) reduced = reduceReviewState(reduced, action);
  return reduced === state ? state : { ...reduced, stateRevision: state.stateRevision + 1 };
}

/** Create one synchronous external store from an authoritative state snapshot. */
export function createReviewStoreFromState(
  initialState: ReviewState,
  options: ReviewStoreOptions = {},
): ReviewStore {
  let snapshot = initialState;
  const listeners = new Set<() => void>();

  /** Validate and publish one already reduced prospective revision. */
  const publish = (next: ReviewState) => {
    options.validateNextSnapshot?.(next, snapshot);
    snapshot = next;
    // Listeners observe the new snapshot synchronously before mutation returns.
    for (const listener of Array.from(listeners)) listener();
    return snapshot;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action) {
      const next = prepareReviewState(snapshot, [action]);
      return next === snapshot ? snapshot : publish(next);
    },
    commitPrepared(expected, next) {
      if (snapshot !== expected) throw new Error("stale-revision");
      return next === expected ? snapshot : publish(next);
    },
  };
}

/** Create one synchronous external store for authoritative semantic review state. */
export function createReviewStore(
  document: ReviewDocumentV1,
  options: ReviewStoreOptions & {
    showAgentNotes?: boolean;
    trustPromptRepoRoot?: string | null;
  } = {},
): ReviewStore {
  return createReviewStoreFromState(createInitialReviewState(document, options), options);
}
