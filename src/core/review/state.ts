/**
 * The authoritative semantic state of one live review, and the policies that read it.
 *
 * Every review consumer — terminal UI, session runtime, browser client — observes this
 * one shape instead of keeping its own selection, filter, note, and expansion state. It
 * stays renderer-free: no rendered rows, no measured geometry, no framework state.
 * Renderer-local concerns (measured line cursors, scroll offsets, pane sizes) stay with
 * the renderer that measures them.
 *
 * Policies that interpret a stored value rather than change it live here too, next to
 * the shape they read, so "which notes are visible" or "where does a note hang" has one
 * named answer rather than an inline conditional per consumer.
 */
import type { ReviewDocumentV1, ReviewLineAddressV1, ReviewNoteV1, ReviewSide } from "./types";

export type ReviewNoteResolution = "active" | "stale" | "orphaned";

/** One mutable note plus the reconciliation verdict its latest anchor check produced. */
export interface ReviewStoredNote {
  note: ReviewNoteV1;
  resolution: ReviewNoteResolution;
}

/**
 * Stale-note visibility policy: a note whose context moved stays visible at its last
 * known anchor, and only a note whose anchor is gone entirely disappears.
 */
export function isRenderableStoredReviewNote(entry: ReviewStoredNote) {
  return entry.resolution !== "orphaned";
}

/**
 * The one note-layer visibility rule.
 *
 * Hiding the note layer hides what the review was given, not what the reviewer wrote:
 * their own notes are their working state and stay on screen. Stated once over the
 * normalized source, so no surface can answer it from a raw producer label
 * (`docs/browser-review-seam-audit.md`, B9).
 */
export function reviewNoteVisibleByPolicy(
  note: Pick<ReviewNoteV1, "source">,
  showAgentNotes: boolean,
) {
  return showAgentNotes || note.source === "user";
}

/**
 * Which hunk renders one note.
 *
 * Ownership is an explicit anchor field rather than a range-containment guess, so a note
 * that core placed through a fallback path is not silently dropped by a consumer that
 * re-derives placement.
 */
export function reviewNoteOwnerHunkIndex(note: ReviewNoteV1) {
  return note.anchor.ownerHunkIndex ?? note.anchor.intersectingHunkIndices[0] ?? 0;
}

/** Which line one note hangs beside, falling back to the new side's first line. */
export function reviewNoteAnchorLine(note: ReviewNoteV1): ReviewLineAddressV1 {
  return note.anchor.preferred ?? { side: "new", line: 1 };
}

export interface ReviewSemanticSelection {
  /** Null while nothing is addressable, e.g. an empty changeset. */
  fileKey: string | null;
  hunkIndex: number;
}

/** Which anchor a selection asks the renderer to bring into view. */
export type ReviewRevealAnchor = "hunk" | "file-top" | "none";

/**
 * What one selection change asks of the viewport.
 *
 * Every user-driven selection carries a request, including `none` — preserving the
 * viewport is a decision, not the absence of one. State reconciliation (clamping an
 * index, falling back to another file) carries no request at all and leaves the
 * reviewer's scroll position and note preference exactly as they were.
 */
export interface ReviewRevealRequest {
  anchor: ReviewRevealAnchor;
  /** Prefer the selected hunk's note over the hunk itself as the reveal target. */
  scrollToNote: boolean;
}

/**
 * Reveal counters observed by whichever renderer implements each anchor.
 *
 * Renderers reveal on a *change* of the counter, so re-selecting the same target still
 * scrolls, while a selection that deliberately preserves the viewport never does.
 */
export interface ReviewRevealIntent {
  fileTopToken: number;
  hunkToken: number;
  scrollToNote: boolean;
}

/**
 * The viewport-anchor policy: adopt what the viewport already settled on.
 *
 * A renderer that scrolls and then publishes the hunk it came to rest on is reporting
 * where the reviewer is, not asking to be moved. Anchoring therefore requests no anchor
 * and clears any note preference, so the counters stay put and no other attached surface
 * is scrolled by this one's scrolling (`docs/browser-review-seam-audit.md`, B11).
 */
export const REVIEW_VIEWPORT_ANCHOR_REVEAL: ReviewRevealRequest = Object.freeze({
  anchor: "none",
  scrollToNote: false,
});

/** Advance the reveal counters one selection request asks for. */
export function applyReviewRevealRequest(
  current: ReviewRevealIntent,
  request: ReviewRevealRequest,
): ReviewRevealIntent {
  return {
    fileTopToken: current.fileTopToken + (request.anchor === "file-top" ? 1 : 0),
    hunkToken: current.hunkToken + (request.anchor === "hunk" ? 1 : 0),
    scrollToNote: request.scrollToNote,
  };
}

/** Compare two reveal intents by value so an unchanged request stays a no-op. */
export function reviewRevealIntentsEqual(left: ReviewRevealIntent, right: ReviewRevealIntent) {
  return (
    left.fileTopToken === right.fileTopToken &&
    left.hunkToken === right.hunkToken &&
    left.scrollToNote === right.scrollToNote
  );
}

export interface ReviewDraftNote {
  id: string;
  fileKey: string;
  hunkIndex: number;
  side: ReviewSide;
  line: number;
  body: string;
}

export type ReviewSourceStatus =
  | { kind: "loading" }
  | { kind: "loaded"; text: string }
  | { kind: "error"; reason?: "too-large" };

export interface ReviewExpandedGapState {
  fileKey: string;
  gapId: string;
  expanded: boolean;
}

export interface ReviewState {
  document: ReviewDocumentV1;
  /** Monotonic counter advanced by every state-changing dispatch. */
  stateRevision: number;
  selection: ReviewSemanticSelection;
  reveal: ReviewRevealIntent;
  filter: string;
  showAgentNotes: boolean;
  /** Notes contributed by agents during the review, in arrival order. */
  liveNotes: ReviewStoredNote[];
  /** Notes written by the reviewer, in creation order. */
  userNotes: ReviewStoredNote[];
  draftNote: ReviewDraftNote | null;
  expandedGaps: ReviewExpandedGapState[];
  sourceStatusByFileKey: Record<string, ReviewSourceStatus>;
}

/** Create the first authoritative semantic state for one review document. */
export function createInitialReviewState(
  document: ReviewDocumentV1,
  options: { showAgentNotes?: boolean } = {},
): ReviewState {
  return {
    document,
    stateRevision: 0,
    selection: {
      fileKey: document.files[0]?.key ?? null,
      hunkIndex: 0,
    },
    reveal: {
      fileTopToken: 0,
      hunkToken: 0,
      scrollToNote: false,
    },
    filter: "",
    showAgentNotes: options.showAgentNotes ?? false,
    liveNotes: [],
    userNotes: [],
    draftNote: null,
    expandedGaps: [],
    sourceStatusByFileKey: {},
  };
}
