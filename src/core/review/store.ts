import type { ReviewAction } from "./actions";
import { reduceReviewState } from "./reducer";
import { createInitialReviewState, type ReviewState } from "./state";
import type { ReviewDocumentV1 } from "./types";

export interface ReviewStore {
  getSnapshot(): ReviewState;
  subscribe(listener: () => void): () => void;
  dispatch(action: ReviewAction): ReviewState;
}

/** Create one synchronous external store from an authoritative state snapshot. */
export function createReviewStoreFromState(initialState: ReviewState): ReviewStore {
  let snapshot = initialState;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action) {
      const reduced = reduceReviewState(snapshot, action);
      if (reduced === snapshot) return snapshot;
      snapshot = { ...reduced, stateRevision: snapshot.stateRevision + 1 };
      // Listeners observe the new snapshot synchronously before dispatch returns.
      for (const listener of Array.from(listeners)) listener();
      return snapshot;
    },
  };
}

/** Create one synchronous external store for authoritative semantic review state. */
export function createReviewStore(
  document: ReviewDocumentV1,
  options: { showAgentNotes?: boolean } = {},
): ReviewStore {
  return createReviewStoreFromState(createInitialReviewState(document, options));
}
