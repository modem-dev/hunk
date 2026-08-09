import type { ReviewDocumentGeneration, ReviewDocumentV1, ReviewNoteV1, ReviewSide } from "./types";

export type ReviewNoteResolution = "active" | "stale" | "orphaned";

/** Stale mutable notes remain visible at their last-known anchor until context rematches. */
export const STALE_MUTABLE_NOTE_VISIBILITY_POLICY = "visible-at-last-known-anchor" as const;

export interface ReviewSemanticSelection {
  fileKey: string | null;
  hunkIndex: number;
  side?: ReviewSide;
  line?: number;
  contextDigest?: string;
}

export interface ReviewRevealIntent {
  token: number;
  fileTopToken: number;
  hunkToken: number;
  lineToken: number;
  kind: "hunk" | "file-top" | "line";
  scrollToNote: boolean;
}

export interface ReviewStoredNoteAddress {
  documentIdentity: string;
  fileKey: string;
  path: string;
  previousPath?: string;
}

export interface ReviewStoredNote {
  note: ReviewNoteV1;
  /** Preferred-address digest retained for compatibility and navigation rematching. */
  contextDigest?: string;
  /** Independent evidence for every declared side range. */
  contextDigests?: Partial<Record<ReviewSide, string>>;
  resolution: ReviewNoteResolution;
  /** Original source-scoped address retained so an orphan can reattach later. */
  originalAddress?: ReviewStoredNoteAddress;
}

/** Apply the explicit stale-note policy shared by renderers and broker adapters. */
export function isRenderableStoredReviewNote(entry: ReviewStoredNote) {
  return entry.resolution !== "orphaned";
}

export interface ReviewDraftNote {
  id: string;
  fileKey: string;
  hunkIndex: number;
  side: ReviewSide;
  line: number;
  oldRange?: [number, number];
  newRange?: [number, number];
  body: string;
}

export type ReviewSourceStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; text: string }
  | { kind: "error"; reason?: "too-large" };

export interface ReviewExpandedGapState {
  fileKey: string;
  gapId: string;
  side: ReviewSide;
  oldRange: readonly [number, number];
  newRange: readonly [number, number];
  sourceIdentity: string;
  expanded: boolean;
}

export interface ReviewState {
  document: ReviewDocumentV1;
  documentGeneration: ReviewDocumentGeneration;
  documentRevision: number;
  stateRevision: number;
  selection: ReviewSemanticSelection;
  reveal: ReviewRevealIntent;
  filter: string;
  showAgentNotes: boolean;
  trustPromptRepoRoot: string | null;
  liveNotes: ReviewStoredNote[];
  userNotes: ReviewStoredNote[];
  draftNote: ReviewDraftNote | null;
  expandedGaps: ReviewExpandedGapState[];
  sourceStatusByFileKey: Record<string, ReviewSourceStatus>;
}

/** Create the first authoritative semantic state for one review document. */
export function createInitialReviewState(
  document: ReviewDocumentV1,
  options: { showAgentNotes?: boolean; trustPromptRepoRoot?: string | null } = {},
): ReviewState {
  return {
    document,
    documentGeneration: document.generation,
    documentRevision: 0,
    stateRevision: 0,
    selection: {
      fileKey: document.files[0]?.key ?? null,
      hunkIndex: 0,
    },
    reveal: {
      token: 0,
      fileTopToken: 0,
      hunkToken: 0,
      lineToken: 0,
      kind: "hunk",
      scrollToNote: false,
    },
    filter: "",
    showAgentNotes: options.showAgentNotes ?? false,
    trustPromptRepoRoot: options.trustPromptRepoRoot ?? null,
    liveNotes: [],
    userNotes: [],
    draftNote: null,
    expandedGaps: [],
    sourceStatusByFileKey: {},
  };
}
