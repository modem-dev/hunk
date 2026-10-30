/**
 * Holds review state and notifies subscribers when it changes.
 *
 * Stays framework-free: `getSnapshot` / `subscribe` / `dispatch` is the whole contract —
 * enough for a React subscription, for a session runtime holding a review outside any
 * renderer, and for a future wire adapter that mirrors changes to a client. Dispatch
 * runs synchronously so a caller can read the result of its own mutation before
 * returning; agent-facing commands answer with the state they just produced.
 */
import type { ReviewAction } from "./actions";
import { reduceReviewState } from "./reducer";
import { createInitialReviewState, type ReviewState } from "./state";
import type { ReviewDocumentV1 } from "./types";

export interface ReviewStore {
  getSnapshot(): ReviewState;
  /** Observe every state change; the listener reads the new state through `getSnapshot`. */
  subscribe(listener: () => void): () => void;
  /** Apply one action and return the resulting state, unchanged when it was a no-op. */
  dispatch(action: ReviewAction): ReviewState;
}

/** Create one review store for a freshly loaded review document. */
export function createReviewStore(
  document: ReviewDocumentV1,
  options: { showAgentNotes?: boolean } = {},
): ReviewStore {
  let snapshot = createInitialReviewState(document, options);
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action) {
      const next = reduceReviewState(snapshot, action);
      if (next === snapshot) {
        return snapshot;
      }
      snapshot = { ...next, stateRevision: snapshot.stateRevision + 1 };
      // Iterate a copy: a listener may subscribe or unsubscribe while being notified.
      for (const listener of Array.from(listeners)) {
        listener();
      }
      return snapshot;
    },
  };
}
