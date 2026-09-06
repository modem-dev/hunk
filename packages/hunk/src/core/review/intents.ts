/**
 * Validates what a reviewer asked for and lowers it into reducer actions.
 *
 * Every surface submits the same intents, so the terminal, the session runtime, and a
 * future browser client cannot disagree about what "save this note" means. Planning is
 * pure — identity and time arrive as caller-supplied facts — and either produces a
 * complete plan or throws a typed rejection before any state is published.
 *
 * The intent vocabulary grows with the phases that need it: navigation intents and the
 * live-agent note lifecycle still resolve at their current owners.
 */
import type { ReviewAction } from "./actions";
import { reviewLineAnchor } from "./anchors";
import { reviewExpansionSide, reviewGapAddress, reviewGapSourceForFile } from "./expansion";
import { reviewDefaultHunkLineTarget } from "./geometry";
import { reviewNoteWithinSizeLimit } from "./noteSize";
import {
  EMPTY_REVIEW_ANNOTATION_INDEX,
  planReviewSelectionMove,
  REVIEW_FILE_JUMP_HUNK_INDEX,
  REVIEW_FILE_JUMP_REVEAL,
  type ReviewAnnotationIndex,
  type ReviewSelectionScope,
} from "./navigation";
import {
  isReviewGapExpanded,
  isReviewNoteWithinClearScope,
  reviewNoteCurrentOwnerHunkIndex,
  reviewNoteHasDescendants,
  selectNormalizedSelection,
  selectReviewFileByKey,
  selectReviewNavigationFiles,
  selectStoredReviewNoteById,
  selectStoredReviewNotes,
} from "./selectors";
import {
  REVIEW_VIEWPORT_ANCHOR_REVEAL,
  type ReviewDraftNote,
  type ReviewRevealRequest,
  type ReviewState,
  type ReviewStoredNote,
} from "./state";
import type { ReviewStore } from "./store";
import type { ReviewFileV1, ReviewLineAddressV1, ReviewLineRange, ReviewSide } from "./types";

/**
 * The facts core refuses to invent, supplied by whoever submits an intent.
 *
 * Identity, time, and the annotation index all depend on the runtime a review is hosted
 * in, so planning reads them from here instead of reaching for a clock, a UUID source, or
 * a note set the semantic document does not carry.
 */
export interface ReviewIntentFacts {
  /** Caller-allocated identity for a newly persisted note. */
  noteId?: string;
  /**
   * Caller-allocated identity for a newly started draft.
   *
   * Separate from `noteId` because a draft outlives none of it: the draft is addressable
   * while it is being written — a renderer reveals it, an agent may report it — and the
   * note it becomes is allocated only when it is saved.
   */
  draftId?: string;
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
  /** Select one hunk outright, revealing it the way the caller asks. */
  | { type: "selection/select"; fileKey: string; hunkIndex: number; reveal: ReviewRevealRequest }
  /** Step the selection through one navigable scope; the scope decides wrap and reveal. */
  | { type: "selection/move"; scope: ReviewSelectionScope; delta: number }
  /** Jump to one file, landing on its first hunk. */
  | { type: "selection/select-file"; fileKey: string; reveal?: ReviewRevealRequest }
  /** Adopt the position a renderer's viewport settled on, without moving any viewport. */
  | { type: "selection/anchor"; fileKey: string; hunkIndex: number }
  /** Replace the review's file filter, which decides the visible stream. */
  | { type: "filter/set"; filter: string }
  /** Set whether agent notes are shown; reviewer-authored notes stay visible either way. */
  | { type: "notes/set-visibility"; visible: boolean }
  /** Open a draft at one hunk, defaulting to the line a whole-hunk note hangs from. */
  | {
      type: "notes/start-draft";
      fileKey: string;
      hunkIndex: number;
      target?: ReviewLineAddressV1;
      reveal?: ReviewRevealRequest;
    }
  /** Open an editable reviewer note in the shared composer. */
  | { type: "notes/start-edit"; noteId: string; reveal?: ReviewRevealRequest }
  /** Open a reply composer beneath one semantically stored note. */
  | { type: "notes/start-reply"; noteId: string; reveal?: ReviewRevealRequest }
  /** Replace the active composer's body. */
  | { type: "notes/update-draft"; body: string }
  /** Retire the active composer without persisting it. */
  | { type: "notes/cancel-draft" }
  /** Persist an active create/reply draft; a blank body retires the draft instead. */
  | { type: "notes/create-user"; consumeDraft: true }
  /** Commit an active edit draft against the same saved user note. */
  | { type: "notes/update-user"; noteId: string; consumeDraft: true }
  /** Delete one reviewer-authored note by id. */
  | { type: "notes/remove-user"; noteId: string }
  /** Dismiss one live agent note by id, leaving reviewer notes untouched. */
  | { type: "notes/remove-live"; noteId: string }
  | { type: "notes/clear"; fileKey?: string; includeUser?: boolean }
  /** Flip one addressable collapsed gap between collapsed and expanded. */
  | { type: "expansion/toggle"; fileKey: string; gapId: string };

/**
 * Every intent type, as a value rather than only as a type.
 *
 * The wire vocabulary is derived from this list instead of restated beside it
 * (`docs/browser-review-seam-audit.md`, B12). The assertion below makes the list total —
 * adding a member to `ReviewIntent` without naming it here fails to typecheck — and
 * `packages/hunk/src/session/reviewProtocol.ts` subtracts a named exclusion list from it rather than
 * writing its own.
 */
export const REVIEW_INTENT_TYPES = [
  "selection/select",
  "selection/move",
  "selection/select-file",
  "selection/anchor",
  "filter/set",
  "notes/set-visibility",
  "notes/start-draft",
  "notes/start-edit",
  "notes/start-reply",
  "notes/update-draft",
  "notes/cancel-draft",
  "notes/create-user",
  "notes/update-user",
  "notes/remove-user",
  "notes/remove-live",
  "notes/clear",
  "expansion/toggle",
] as const satisfies readonly ReviewIntent["type"][];

export type ReviewIntentType = (typeof REVIEW_INTENT_TYPES)[number];

// Totality in the other direction: `satisfies` above proves every listed name is a real
// intent, and this proves every real intent is listed. A missing member resolves to a
// string literal here instead of `never`, which is not assignable to `never`.
const _everyReviewIntentIsListed: never = undefined as unknown as Exclude<
  ReviewIntent["type"],
  ReviewIntentType
>;
void _everyReviewIntentIsListed;

export interface ReviewSelectionChangedOutcome {
  type: "selection/changed";
  fileKey: string;
  hunkIndex: number;
}

export interface ReviewNoteCreatedOutcome {
  type: "notes/created";
  note: ReviewStoredNote;
}

export interface ReviewNoteUpdatedOutcome {
  type: "notes/updated";
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

export interface ReviewDraftStartedOutcome {
  type: "notes/draft-started";
  draft: ReviewDraftNote;
}

/**
 * What a gap toggle settled on, and everything a caller needs to fill it.
 *
 * The resolved address travels with the outcome rather than being looked up again: the
 * side whose source text fills the gap, both per-side ranges, and the identity of the
 * content behind them. A caller that re-derived any of those could expand a different
 * range than the one the review just recorded as expanded.
 */
export interface ReviewExpansionToggledOutcome {
  type: "expansion/toggled";
  fileKey: string;
  gapId: string;
  expanded: boolean;
  side: ReviewSide;
  oldRange: ReviewLineRange;
  newRange: ReviewLineRange;
  lineCount: number;
  /** Absent when the file has no expandable source behind it. */
  sourceIdentity?: string;
}

export type ReviewIntentOutcome =
  | ReviewSelectionChangedOutcome
  | ReviewDraftStartedOutcome
  | ReviewNoteCreatedOutcome
  | ReviewNoteUpdatedOutcome
  | ReviewNoteRemovedOutcome
  | ReviewNotesClearedOutcome
  | ReviewExpansionToggledOutcome;

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
  "notes/start-draft": ReviewDraftStartedOutcome;
  "notes/start-edit": ReviewDraftStartedOutcome;
  "notes/start-reply": ReviewDraftStartedOutcome;
  "notes/update-draft": undefined;
  "notes/cancel-draft": undefined;
  "notes/create-user": ReviewNoteCreatedOutcome | undefined;
  "notes/update-user": ReviewNoteUpdatedOutcome;
  "notes/remove-user": ReviewNoteRemovedOutcome;
  "notes/remove-live": ReviewNoteRemovedOutcome;
  "notes/clear": ReviewNotesClearedOutcome;
  "expansion/toggle": ReviewExpansionToggledOutcome;
}

export interface ReviewIntentPlan {
  actions: readonly ReviewAction[];
  /** Concrete result of the intent; absent when it only moved state. */
  outcome?: ReviewIntentOutcome;
}

export type ReviewIntentPlanningErrorCode =
  | "file-not-found"
  | "hunk-not-found"
  | "gap-not-found"
  | "draft-missing"
  | "draft-active"
  | "draft-mode-mismatch"
  | "note-not-found"
  | "note-not-editable"
  | "note-has-replies"
  | "note-id-conflict"
  | "invalid-note-parent"
  | "blank-note"
  | "note-too-large"
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
 * Decides what counts as a blank note body.
 *
 * Surfaces differ in what they do about a blank body — the terminal quietly retires the
 * draft, an agent command reports a rejection — but not in what counts as blank.
 */
export function isBlankReviewNoteBody(body: string) {
  return body.trim().length === 0;
}

/** Require one caller-owned fact without letting core allocate identity or time. */
function requireFact(value: string | undefined, label: "noteId" | "draftId" | "timestamp") {
  if (!value) {
    throw new ReviewIntentPlanningError("missing-fact", `Review intent requires ${label}.`);
  }
  return value;
}

/**
 * Resolve one current semantic file or reject the target.
 *
 * Exported because a caller validating an action before it plans one asks the same
 * question, and the rejection a caller reports must be the rejection planning would have
 * produced — the same code and the same words, not a second phrasing of them.
 */
export function requireReviewFile(state: ReviewState, fileKey: string): ReviewFileV1 {
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

/**
 * The reveal a freshly opened draft asks for by default.
 *
 * Starting a note is a deliberate move to the place the note is about, and the note card
 * is what the reviewer needs on screen — not the hunk header above it. Callers adopting a
 * position they already scrolled to pass `REVIEW_VIEWPORT_ANCHOR_REVEAL` instead.
 */
export const REVIEW_DRAFT_START_REVEAL: ReviewRevealRequest = Object.freeze({
  anchor: "hunk",
  scrollToNote: true,
});

/** Plan opening one draft note, with the caller owning its identity. */
function planDraftStart(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "notes/start-draft" }>,
  facts: ReviewIntentFacts,
): ReviewIntentPlan {
  const file = requireReviewFile(state, intent.fileKey);
  requireHunk(file, intent.hunkIndex);
  const hunk = file.hunks[intent.hunkIndex]!;
  // Where a note about the whole hunk belongs is one shared answer; a caller that
  // measured a specific line the reviewer put a cursor on overrides it.
  const target = intent.target ?? reviewDefaultHunkLineTarget(hunk);
  if (state.draftNote) {
    throw new ReviewIntentPlanningError("draft-active", "A review note draft is already active.");
  }
  const draft: ReviewDraftNote = {
    kind: "create",
    id: requireFact(facts.draftId, "draftId"),
    fileKey: file.key,
    hunkIndex: intent.hunkIndex,
    side: target.side,
    line: target.line,
    body: "",
  };
  return {
    actions: [
      { type: "draft/start", draft },
      {
        type: "selection/select",
        fileKey: file.key,
        hunkIndex: intent.hunkIndex,
        reveal: intent.reveal ?? REVIEW_DRAFT_START_REVEAL,
      },
    ],
    outcome: { type: "notes/draft-started", draft },
  };
}

/** Build a composer transaction at one stored note's authoritative anchor. */
function draftForStoredNote(
  state: ReviewState,
  entry: ReviewStoredNote,
  facts: ReviewIntentFacts,
  mode: "edit" | "reply",
): ReviewDraftNote {
  const file = requireReviewFile(state, entry.note.fileKey);
  const hunkIndex = reviewNoteCurrentOwnerHunkIndex(entry.note, file);
  requireHunk(file, hunkIndex);
  const target = entry.note.anchor.preferred ?? { side: "new" as const, line: 1 };
  const common = {
    id: requireFact(facts.draftId, "draftId"),
    fileKey: file.key,
    hunkIndex,
    side: target.side,
    line: target.line,
  };
  return mode === "edit"
    ? { ...common, kind: "edit", targetNoteId: entry.note.id, body: entry.note.summary }
    : { ...common, kind: "reply", parentId: entry.note.id, body: "" };
}

/** Plan opening an existing reviewer note for identity-preserving editing. */
function planDraftEditStart(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "notes/start-edit" }>,
  facts: ReviewIntentFacts,
): ReviewIntentPlan {
  if (state.draftNote) {
    throw new ReviewIntentPlanningError("draft-active", "A review note draft is already active.");
  }
  const entry = state.userNotes.find(({ note }) => note.id === intent.noteId);
  if (!entry) {
    throw new ReviewIntentPlanningError(
      "note-not-found",
      `No user review note matches id ${intent.noteId}.`,
    );
  }
  if (!entry.note.editable) {
    throw new ReviewIntentPlanningError(
      "note-not-editable",
      `Review note ${intent.noteId} is not editable.`,
    );
  }
  const draft = draftForStoredNote(state, entry, facts, "edit");
  return {
    actions: [
      { type: "draft/start", draft },
      {
        type: "selection/select",
        fileKey: draft.fileKey,
        hunkIndex: draft.hunkIndex,
        reveal: intent.reveal ?? REVIEW_DRAFT_START_REVEAL,
      },
    ],
    outcome: { type: "notes/draft-started", draft },
  };
}

/** Plan opening a reply composer under one semantically stored note. */
function planDraftReplyStart(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "notes/start-reply" }>,
  facts: ReviewIntentFacts,
): ReviewIntentPlan {
  if (state.draftNote) {
    throw new ReviewIntentPlanningError("draft-active", "A review note draft is already active.");
  }
  const entry = selectStoredReviewNoteById(state, intent.noteId);
  if (!entry || entry.resolution === "orphaned") {
    throw new ReviewIntentPlanningError(
      "note-not-found",
      `No replyable review note matches id ${intent.noteId}.`,
    );
  }
  const draft = draftForStoredNote(state, entry, facts, "reply");
  return {
    actions: [
      { type: "draft/start", draft },
      {
        type: "selection/select",
        fileKey: draft.fileKey,
        hunkIndex: draft.hunkIndex,
        reveal: intent.reveal ?? REVIEW_DRAFT_START_REVEAL,
      },
    ],
    outcome: { type: "notes/draft-started", draft },
  };
}

/** Plan flipping one collapsed gap, resolving the address it names. */
function planExpansionToggle(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "expansion/toggle" }>,
): ReviewIntentPlan {
  const file = requireReviewFile(state, intent.fileKey);
  // Validated against the same addressing every renderer draws and every note-line check
  // accepts, so a gap a surface can offer is exactly a gap this intent can expand (A1).
  const address = reviewGapAddress(reviewGapSourceForFile(file), intent.gapId);
  if (!address) {
    throw new ReviewIntentPlanningError(
      "gap-not-found",
      `Review gap ${intent.gapId} does not exist in ${file.path}.`,
    );
  }

  const expanded = !isReviewGapExpanded(state, file.key, intent.gapId);
  return {
    actions: [{ type: "expansion/toggle", fileKey: file.key, gapId: intent.gapId, expanded }],
    outcome: {
      type: "expansion/toggled",
      fileKey: file.key,
      gapId: intent.gapId,
      expanded,
      side: reviewExpansionSide(file.changeKind),
      oldRange: address.oldRange,
      newRange: address.newRange,
      lineCount: address.lineCount,
      ...(file.sourceIdentity !== undefined ? { sourceIdentity: file.sourceIdentity } : {}),
    },
  };
}

/** Plan persistence of an active create/reply draft as one user note. */
function planUserNoteCreation(state: ReviewState, facts: ReviewIntentFacts): ReviewIntentPlan {
  const draft = state.draftNote;
  if (!draft) {
    throw new ReviewIntentPlanningError("draft-missing", "No user note draft is active.");
  }
  if (draft.kind === "edit") {
    throw new ReviewIntentPlanningError(
      "draft-mode-mismatch",
      "The active review note draft must be committed as an edit.",
    );
  }
  const file = requireReviewFile(state, draft.fileKey);
  requireHunk(file, draft.hunkIndex);
  if (isBlankReviewNoteBody(draft.body)) {
    return { actions: [{ type: "draft/cancel" }] };
  }

  const noteId = requireFact(facts.noteId, "noteId");
  if (selectStoredReviewNoteById(state, noteId)) {
    throw new ReviewIntentPlanningError(
      "note-id-conflict",
      `Review note id ${noteId} is already in use.`,
    );
  }

  const parent =
    draft.kind === "reply" ? selectStoredReviewNoteById(state, draft.parentId) : undefined;
  if (draft.kind === "reply" && (!parent || parent.resolution === "orphaned")) {
    throw new ReviewIntentPlanningError(
      "invalid-note-parent",
      `Review note ${draft.parentId} is no longer available as a reply parent.`,
    );
  }
  if (parent && parent.note.fileKey !== file.key) {
    throw new ReviewIntentPlanningError(
      "invalid-note-parent",
      `Review note ${parent.note.id} belongs to a different file.`,
    );
  }

  const note: ReviewStoredNote = {
    note: {
      id: noteId,
      ...(parent ? { parentId: parent.note.id } : {}),
      source: "user",
      originalSource: "user",
      fileKey: file.key,
      anchor: parent ? parent.note.anchor : reviewLineAnchor(file.hunks, draft),
      summary: draft.body.trim(),
      author: "user",
      createdAt: requireFact(facts.timestamp, "timestamp"),
      editable: true,
    },
    resolution: parent?.resolution ?? "active",
  };
  if (!reviewNoteWithinSizeLimit(note.note)) {
    throw new ReviewIntentPlanningError(
      "note-too-large",
      "The review note exceeds the shared note size limit.",
    );
  }
  return {
    actions: [{ type: "draft/save", note }],
    outcome: { type: "notes/created", note },
  };
}

/** Plan an identity-preserving update of one editable user note. */
function planUserNoteUpdate(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "notes/update-user" }>,
  facts: ReviewIntentFacts,
): ReviewIntentPlan {
  const draft = state.draftNote;
  if (!draft) {
    throw new ReviewIntentPlanningError("draft-missing", "No user note draft is active.");
  }
  if (draft.kind !== "edit" || draft.targetNoteId !== intent.noteId) {
    throw new ReviewIntentPlanningError(
      "draft-mode-mismatch",
      `The active draft is not editing review note ${intent.noteId}.`,
    );
  }
  const current = state.userNotes.find(({ note }) => note.id === intent.noteId);
  if (!current) {
    throw new ReviewIntentPlanningError(
      "note-not-found",
      `No user review note matches id ${intent.noteId}.`,
    );
  }
  if (!current.note.editable) {
    throw new ReviewIntentPlanningError(
      "note-not-editable",
      `Review note ${intent.noteId} is not editable.`,
    );
  }
  if (isBlankReviewNoteBody(draft.body)) {
    throw new ReviewIntentPlanningError(
      "blank-note",
      "An edited review note cannot be blank; cancel or delete it instead.",
    );
  }
  const note: ReviewStoredNote = {
    ...current,
    note: {
      ...current.note,
      summary: draft.body.trim(),
      updatedAt: requireFact(facts.timestamp, "timestamp"),
    },
  };
  if (!reviewNoteWithinSizeLimit(note.note)) {
    throw new ReviewIntentPlanningError(
      "note-too-large",
      "The review note exceeds the shared note size limit.",
    );
  }
  return {
    actions: [{ type: "draft/save-edit", note }],
    outcome: { type: "notes/updated", note },
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
  if (reviewNoteHasDescendants(state, intent.noteId)) {
    throw new ReviewIntentPlanningError(
      "note-has-replies",
      `Review note ${intent.noteId} cannot be removed while it has replies.`,
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
  const removedLive = state.liveNotes.filter(cleared);
  const removedUser = intent.includeUser ? state.userNotes.filter(cleared) : [];
  const removedLiveCount = removedLive.length;
  const removedUserCount = removedUser.length;
  const removedIds = new Set([...removedLive, ...removedUser].map(({ note }) => note.id));
  const leavesDanglingReply = selectStoredReviewNotes(state).some(
    ({ note }) =>
      !removedIds.has(note.id) && note.parentId !== undefined && removedIds.has(note.parentId),
  );
  if (leavesDanglingReply) {
    throw new ReviewIntentPlanningError(
      "note-has-replies",
      "Review notes cannot be cleared while replies to them would remain.",
    );
  }
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
      const file = requireReviewFile(state, intent.fileKey);
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
      const file = requireReviewFile(state, intent.fileKey);
      return planSelection(
        file.key,
        REVIEW_FILE_JUMP_HUNK_INDEX,
        intent.reveal ?? REVIEW_FILE_JUMP_REVEAL,
      );
    }
    case "selection/anchor": {
      const file = requireReviewFile(state, intent.fileKey);
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
    case "notes/start-draft":
      return planDraftStart(state, intent, facts);
    case "notes/start-edit":
      return planDraftEditStart(state, intent, facts);
    case "notes/start-reply":
      return planDraftReplyStart(state, intent, facts);
    case "notes/update-draft":
      if (!state.draftNote) {
        throw new ReviewIntentPlanningError("draft-missing", "No user note draft is active.");
      }
      return { actions: [{ type: "draft/update", body: intent.body }] };
    case "notes/cancel-draft":
      if (!state.draftNote) {
        throw new ReviewIntentPlanningError("draft-missing", "No user note draft is active.");
      }
      return { actions: [{ type: "draft/cancel" }] };
    case "expansion/toggle":
      return planExpansionToggle(state, intent);
    case "notes/create-user":
      return planUserNoteCreation(state, facts);
    case "notes/update-user":
      return planUserNoteUpdate(state, intent, facts);
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
