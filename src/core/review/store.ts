import type { ReviewAction } from "./actions";
import { reduceReviewState } from "./reducer";
import { createInitialReviewState, type ReviewState } from "./state";
import type { ReviewDocumentV1 } from "./types";

export interface ReviewStore {
  getSnapshot(): ReviewState;
  /** Observe every state change, including terminal-local draft edits. */
  subscribe(listener: () => void): () => void;
  /** Observe only changes that advance the externally visible semantic revision. */
  subscribePublished(listener: () => void): () => void;
  dispatch(action: ReviewAction): ReviewState;
  /** Commit an already validated state only if its source snapshot is still current. */
  commitPrepared(expected: ReviewState, next: ReviewState): ReviewState;
}

export interface ReviewStoreOptions {
  /** Reject a prospective revision before it becomes observable or authoritative. */
  validateNextSnapshot?: (next: ReviewState, previous: ReviewState) => void;
}

/** Return whether an action changes only terminal-local draft editing state. */
function isLocalDraftAction(action: ReviewAction) {
  return (
    action.type === "draft/start" ||
    action.type === "draft/update" ||
    action.type === "draft/cancel"
  );
}

/** Reduce several semantic actions into one prospective revision without publishing. */
export function prepareReviewState(state: ReviewState, actions: readonly ReviewAction[]) {
  let reduced = state;
  let publishedChange = false;
  for (const action of actions) {
    const next = reduceReviewState(reduced, action);
    if (next !== reduced && !isLocalDraftAction(action)) publishedChange = true;
    reduced = next;
  }
  if (reduced === state) return state;
  return publishedChange ? { ...reduced, stateRevision: state.stateRevision + 1 } : reduced;
}

/** Create one synchronous external store from an authoritative state snapshot. */
export function createReviewStoreFromState(
  initialState: ReviewState,
  options: ReviewStoreOptions = {},
): ReviewStore {
  let snapshot = initialState;
  const listeners = new Set<() => void>();
  const publishedListeners = new Set<() => void>();

  /** Validate and publish one already reduced prospective revision. */
  const publish = (next: ReviewState) => {
    const previous = snapshot;
    const isPublishedChange = next.stateRevision !== previous.stateRevision;
    if (isPublishedChange) options.validateNextSnapshot?.(next, previous);
    snapshot = next;
    // General listeners keep terminal-local draft editing synchronous with the controller.
    for (const listener of Array.from(listeners)) listener();
    if (isPublishedChange) {
      for (const listener of Array.from(publishedListeners)) listener();
    }
    return snapshot;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribePublished(listener) {
      publishedListeners.add(listener);
      return () => publishedListeners.delete(listener);
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
