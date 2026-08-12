/**
 * Semantic intents: what a reviewer asked for, decided once, for every surface.
 *
 * An intent is validated and lowered into reducer actions here, so the terminal, the
 * session runtime, and a future browser client cannot disagree about what "save this
 * note" means. Planning is pure — identity and time arrive as caller-supplied facts —
 * and it either produces a complete plan or throws a typed rejection before any state
 * is published.
 *
 * The intent vocabulary grows with the phases that need it: navigation intents and the
 * live-agent note lifecycle still resolve at their current owners.
 */
import type { ReviewAction } from "./actions";
import { reviewLineAnchor } from "./anchors";
import {
  EMPTY_REVIEW_ANNOTATION_INDEX,
  planReviewSelectionMove,
  REVIEW_FILE_JUMP_HUNK_INDEX,
  REVIEW_FILE_JUMP_REVEAL,
  type ReviewAnnotationIndex,
  type ReviewSelectionScope,
} from "./navigation";
import {
  isReviewNoteWithinClearScope,
  selectNormalizedSelection,
  selectReviewFileByKey,
  selectReviewNavigationFiles,
} from "./selectors";
import {
  REVIEW_VIEWPORT_ANCHOR_REVEAL,
  type ReviewRevealRequest,
  type ReviewState,
  type ReviewStoredNote,
} from "./state";
import type { ReviewStore } from "./store";
import type { ReviewFileV1 } from "./types";

export interface ReviewIntentFacts {
  /** Caller-allocated identity for a newly persisted note. */
  noteId?: string;
  /** Caller-owned ISO timestamp for note creation. */
  timestamp?: string;
  /**
   * Which files and hunks currently carry notes, for annotated navigation.
   *
   * A caller-owned fact like the two above: notes reach a review from sources the
   * semantic document does not carry, and only the consumer that merged them knows the
   * full set.
   */
  annotations?: ReviewAnnotationIndex;
}

export type ReviewIntent =
  | { type: "selection/select"; fileKey: string; hunkIndex: number; reveal: ReviewRevealRequest }
  /** Step the selection through one navigable scope; the scope decides wrap and reveal. */
  | { type: "selection/move"; scope: ReviewSelectionScope; delta: number }
  /** Jump to one file, landing on its first hunk. */
  | { type: "selection/select-file"; fileKey: string; reveal?: ReviewRevealRequest }
  /** Adopt the position a renderer's viewport settled on, without moving any viewport. */
  | { type: "selection/anchor"; fileKey: string; hunkIndex: number }
  | { type: "filter/set"; filter: string }
  | { type: "notes/set-visibility"; visible: boolean }
  /** Persist the active draft; a blank body retires the draft instead. */
  | { type: "notes/create-user"; consumeDraft: true }
  | { type: "notes/remove-user"; noteId: string }
  | { type: "notes/remove-live"; noteId: string }
  | { type: "notes/clear"; fileKey?: string; includeUser?: boolean };

export interface ReviewSelectionChangedOutcome {
  type: "selection/changed";
  fileKey: string;
  hunkIndex: number;
}

export interface ReviewNoteCreatedOutcome {
  type: "notes/created";
  note: ReviewStoredNote;
}

export interface ReviewNoteRemovedOutcome {
  type: "notes/removed";
  noteId: string;
  source: "user" | "live";
}

export interface ReviewNotesClearedOutcome {
  type: "notes/cleared";
  removedLiveCount: number;
  removedUserCount: number;
  remainingLiveCount: number;
  remainingUserCount: number;
}

export type ReviewIntentOutcome =
  | ReviewSelectionChangedOutcome
  | ReviewNoteCreatedOutcome
  | ReviewNoteRemovedOutcome
  | ReviewNotesClearedOutcome;

/**
 * What each intent reports back.
 *
 * Callers that need the result — the id a note was stored under, how many notes a clear
 * removed — get it typed rather than re-narrowing the outcome union at every call site.
 * A blank draft produces no note, which is why note creation is optional here.
 */
export interface ReviewIntentOutcomeByType {
  "selection/select": undefined;
  /** Absent when the scope refused the move and left the selection alone. */
  "selection/move": ReviewSelectionChangedOutcome | undefined;
  "selection/select-file": ReviewSelectionChangedOutcome;
  "selection/anchor": undefined;
  "filter/set": undefined;
  "notes/set-visibility": undefined;
  "notes/create-user": ReviewNoteCreatedOutcome | undefined;
  "notes/remove-user": ReviewNoteRemovedOutcome;
  "notes/remove-live": ReviewNoteRemovedOutcome;
  "notes/clear": ReviewNotesClearedOutcome;
}

export interface ReviewIntentPlan {
  actions: readonly ReviewAction[];
  /** Concrete result of the intent; absent when it only moved state. */
  outcome?: ReviewIntentOutcome;
}

export type ReviewIntentPlanningErrorCode =
  | "file-not-found"
  | "hunk-not-found"
  | "draft-missing"
  | "note-not-found"
  | "missing-fact";

/** Typed semantic rejection raised before any review state is reduced or published. */
export class ReviewIntentPlanningError extends Error {
  override readonly name = "ReviewIntentPlanningError";

  constructor(
    readonly code: ReviewIntentPlanningErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The one empty-note-body rule.
 *
 * Surfaces differ in what they do about a blank body — the terminal quietly retires the
 * draft, an agent command reports a rejection — but not in what counts as blank.
 */
export function isBlankReviewNoteBody(body: string) {
  return body.trim().length === 0;
}

/** Require one caller-owned fact without letting core allocate identity or time. */
function requireFact(value: string | undefined, label: "noteId" | "timestamp") {
  if (!value) {
    throw new ReviewIntentPlanningError("missing-fact", `Review intent requires ${label}.`);
  }
  return value;
}

/** Resolve one current semantic file or reject the target. */
function requireFile(state: ReviewState, fileKey: string): ReviewFileV1 {
  const file = selectReviewFileByKey(state, fileKey);
  if (!file) {
    throw new ReviewIntentPlanningError(
      "file-not-found",
      `Review file ${fileKey} does not exist in the current review.`,
    );
  }
  return file;
}

/** Require one exact hunk instead of relying on selection clamping. */
function requireHunk(file: ReviewFileV1, hunkIndex: number) {
  if (!Number.isSafeInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= file.hunks.length) {
    throw new ReviewIntentPlanningError(
      "hunk-not-found",
      `Review hunk ${hunkIndex} does not exist in ${file.path}.`,
    );
  }
}

/** Lower one resolved selection target into the action that commits it. */
function planSelection(
  fileKey: string,
  hunkIndex: number,
  reveal: ReviewRevealRequest,
): ReviewIntentPlan {
  return {
    actions: [{ type: "selection/select", fileKey, hunkIndex, reveal }],
    outcome: { type: "selection/changed", fileKey, hunkIndex },
  };
}

/**
 * Plan one relative selection move over the currently visible stream.
 *
 * Navigation walks what the reviewer can see: a filtered-out file is not a step away, and
 * the selection it starts from is the normalized one, so a move from a vanished file
 * begins where the review actually is.
 */
function planSelectionMove(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "selection/move" }>,
  facts: ReviewIntentFacts,
): ReviewIntentPlan {
  const annotated = intent.scope === "annotated-hunk" || intent.scope === "annotated-file";
  if (annotated && !facts.annotations) {
    throw new ReviewIntentPlanningError(
      "missing-fact",
      `Review intent requires annotations for ${intent.scope} navigation.`,
    );
  }

  const target = planReviewSelectionMove(
    {
      files: selectReviewNavigationFiles(state),
      annotations: facts.annotations ?? EMPTY_REVIEW_ANNOTATION_INDEX,
    },
    selectNormalizedSelection(state),
    { scope: intent.scope, delta: intent.delta },
  );
  // A refused move publishes nothing at all: no selection change, and no reveal token
  // bump that would scroll a viewport for a key press that went nowhere.
  return target ? planSelection(target.fileKey, target.hunkIndex, target.reveal) : { actions: [] };
}

/** Plan persistence of the active draft as one user note. */
function planUserNoteCreation(state: ReviewState, facts: ReviewIntentFacts): ReviewIntentPlan {
  const draft = state.draftNote;
  if (!draft) {
    throw new ReviewIntentPlanningError("draft-missing", "No user note draft is active.");
  }
  const file = requireFile(state, draft.fileKey);
  requireHunk(file, draft.hunkIndex);
  if (isBlankReviewNoteBody(draft.body)) {
    return { actions: [{ type: "draft/cancel" }] };
  }

  const note: ReviewStoredNote = {
    note: {
      id: requireFact(facts.noteId, "noteId"),
      source: "user",
      originalSource: "user",
      fileKey: file.key,
      anchor: reviewLineAnchor(file.hunks, draft),
      summary: draft.body.trim(),
      author: "user",
      createdAt: requireFact(facts.timestamp, "timestamp"),
      editable: true,
    },
    resolution: "active",
  };
  return {
    actions: [{ type: "draft/save", note }],
    outcome: { type: "notes/created", note },
  };
}

/** Plan removal of one mutable note from the collection that owns it. */
function planNoteRemoval(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "notes/remove-user" | "notes/remove-live" }>,
): ReviewIntentPlan {
  const source = intent.type === "notes/remove-user" ? "user" : "live";
  const notes = source === "user" ? state.userNotes : state.liveNotes;
  if (!notes.some((entry) => entry.note.id === intent.noteId)) {
    throw new ReviewIntentPlanningError(
      "note-not-found",
      `No ${source} review note matches id ${intent.noteId}.`,
    );
  }
  return {
    actions: [
      source === "user"
        ? { type: "notes/remove-user", noteId: intent.noteId }
        : { type: "notes/remove-live", noteId: intent.noteId },
    ],
    outcome: { type: "notes/removed", noteId: intent.noteId, source },
  };
}

/** Plan a bulk clear and report what it removes and leaves behind. */
function planNotesClear(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "notes/clear" }>,
): ReviewIntentPlan {
  const cleared = (entry: ReviewStoredNote) => isReviewNoteWithinClearScope(entry, intent.fileKey);
  const removedLiveCount = state.liveNotes.filter(cleared).length;
  const removedUserCount = intent.includeUser ? state.userNotes.filter(cleared).length : 0;
  return {
    actions: [
      {
        type: "notes/clear",
        ...(intent.fileKey !== undefined ? { fileKey: intent.fileKey } : {}),
        ...(intent.includeUser ? { includeUser: true } : {}),
      },
    ],
    outcome: {
      type: "notes/cleared",
      removedLiveCount,
      removedUserCount,
      remainingLiveCount: state.liveNotes.length - removedLiveCount,
      remainingUserCount: state.userNotes.length - removedUserCount,
    },
  };
}

/** Validate one intent against current state and lower it into reducer actions. */
export function planReviewIntent(
  state: ReviewState,
  intent: ReviewIntent,
  facts: ReviewIntentFacts = {},
): ReviewIntentPlan {
  switch (intent.type) {
    case "selection/select": {
      // Only the file is required: an out-of-range hunk clamps rather than rejecting, so
      // a stale index from a reloaded file still lands the reviewer somewhere real.
      const file = requireFile(state, intent.fileKey);
      return {
        actions: [
          {
            type: "selection/select",
            fileKey: file.key,
            hunkIndex: intent.hunkIndex,
            reveal: intent.reveal,
          },
        ],
      };
    }
    case "selection/move":
      return planSelectionMove(state, intent, facts);
    case "selection/select-file": {
      // The file-jump rule, owned here rather than restated per surface: selecting a file
      // means its first hunk, and the reveal defaults to the file's own header.
      const file = requireFile(state, intent.fileKey);
      return planSelection(
        file.key,
        REVIEW_FILE_JUMP_HUNK_INDEX,
        intent.reveal ?? REVIEW_FILE_JUMP_REVEAL,
      );
    }
    case "selection/anchor": {
      const file = requireFile(state, intent.fileKey);
      return {
        actions: [
          {
            type: "selection/select",
            fileKey: file.key,
            hunkIndex: intent.hunkIndex,
            reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL,
          },
        ],
      };
    }
    case "filter/set":
      return { actions: [{ type: "filter/set", filter: intent.filter }] };
    case "notes/set-visibility":
      return { actions: [{ type: "notes/set-visibility", visible: intent.visible }] };
    case "notes/create-user":
      return planUserNoteCreation(state, facts);
    case "notes/remove-user":
    case "notes/remove-live":
      return planNoteRemoval(state, intent);
    case "notes/clear":
      return planNotesClear(state, intent);
  }
}

/**
 * Plan one intent against the store's current state and commit its actions.
 *
 * Planning happens against one snapshot and either throws before anything is published
 * or produces the whole batch, so a rejected intent leaves no partial change behind.
 */
export function applyReviewIntent<T extends ReviewIntent>(
  store: ReviewStore,
  intent: T,
  facts: ReviewIntentFacts = {},
): ReviewIntentOutcomeByType[T["type"]] {
  const plan = planReviewIntent(store.getSnapshot(), intent, facts);
  for (const action of plan.actions) {
    store.dispatch(action);
  }
  // The planner produces exactly the outcome its intent declares; the map states that
  // correspondence for callers, and this is the one place it is asserted.
  return plan.outcome as ReviewIntentOutcomeByType[T["type"]];
}
