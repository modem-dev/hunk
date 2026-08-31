/**
 * Declares the value shapes every review consumer shares: files addressed by a stable
 * content-derived key rather than by renderer identity, hunks described as explicit
 * JSON-safe records rather than as a renderer's parsed metadata, and notes anchored to
 * line ranges rather than to rendered rows. Says nothing about how a review is drawn or
 * transported.
 *
 * The document carries what every consumer reads. Publication addresses — generations,
 * resource descriptors, digests — belong to the producer runtime and are absent here, so
 * nothing in this file implies a transport.
 */
import type { ReviewNoteSource } from "../run/commandInputs";

export type ReviewSide = "old" | "new";
export type ReviewLineRange = readonly [number, number];
export type ReviewFileChangeKind = "change" | "rename-pure" | "rename-changed" | "new" | "deleted";

export interface ReviewLineAddressV1 {
  side: ReviewSide;
  line: number;
}

export interface ReviewRangeAnchorV1 {
  oldRange?: ReviewLineRange;
  newRange?: ReviewLineRange;
  /** The one line a renderer places the note beside and scrolls to. */
  preferred?: ReviewLineAddressV1;
  /** Every hunk whose old or new range intersects the note, in file order. */
  intersectingHunkIndices: number[];
  /** The one hunk that renders the note; navigation uses the intersections instead. */
  ownerHunkIndex?: number;
}

export interface ReviewNoteV1 {
  id: string;
  /** Direct parent note identity. Roots omit this field; ancestry is derived by selectors. */
  parentId?: string;
  /**
   * Normalized note source. Producers classify a note once, at the boundary where it
   * enters the review, so no consumer re-interprets a raw source label.
   */
  source: ReviewNoteSource;
  /** The raw producer label, retained so an adapter can round-trip it unchanged. */
  originalSource?: string;
  fileKey: string;
  anchor: ReviewRangeAnchorV1;
  summary: string;
  rationale?: string;
  markup?: string;
  title?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  editable: boolean;
  tags?: string[];
  confidence?: "low" | "medium" | "high";
}

export interface ReviewContextBlockV1 {
  type: "context";
  lines: number;
  additionLineIndex: number;
  deletionLineIndex: number;
}

export interface ReviewChangeBlockV1 {
  type: "change";
  additions: number;
  deletions: number;
  additionLineIndex: number;
  deletionLineIndex: number;
}

export type ReviewHunkBlockV1 = ReviewContextBlockV1 | ReviewChangeBlockV1;

/**
 * One hunk as every consumer reads it.
 *
 * `*Start` values are 1-based file lines and `*LineIndex` values are 0-based offsets into
 * the file's `additionLines` / `deletionLines`. The two coordinate systems coincide only
 * for a complete patch; a partial patch carries just the changed lines, which is why the
 * index fields exist at all rather than being derived from the line numbers.
 */
export interface ReviewHunkV1 {
  index: number;
  /** Unchanged lines the patch omitted immediately before this hunk. */
  collapsedBefore: number;
  splitLineStart: number;
  splitLineCount: number;
  unifiedLineStart: number;
  unifiedLineCount: number;
  additionStart: number;
  additionCount: number;
  /** Added lines only; `additionCount` also covers this hunk's context lines. */
  additionLines: number;
  additionLineIndex: number;
  deletionStart: number;
  deletionCount: number;
  /** Deleted lines only; `deletionCount` also covers this hunk's context lines. */
  deletionLines: number;
  deletionLineIndex: number;
  hunkContent: ReviewHunkBlockV1[];
  hunkSpecs?: string;
  hunkContext?: string;
  noEOFCRAdditions: boolean;
  noEOFCRDeletions: boolean;
}

export interface ReviewFileStatsV1 {
  additions: number;
  deletions: number;
  /** The producer counted more than it rendered, so the numbers are a lower bound. */
  truncated: boolean;
}

export interface ReviewFileFlagsV1 {
  untracked: boolean;
  binary: boolean;
  tooLarge: boolean;
  /** The patch carries only changed lines, so line indices are patch-local. */
  partial: boolean;
}

export interface ReviewFileV1 {
  /** Stable semantic address for one reviewed file, independent of renderer identity. */
  key: string;
  /** Transitional renderer-model id; never use it for cross-generation reconciliation. */
  runtimeId: string;
  path: string;
  previousPath?: string;
  changeKind: ReviewFileChangeKind;
  language?: string;
  agentSummary?: string;
  stats: ReviewFileStatsV1;
  flags: ReviewFileFlagsV1;
  /**
   * The file's unified diff text, as the producer that loaded it supplied it.
   *
   * Carried rather than left behind in the renderer's model: it is content, not
   * publication, every consumer that offers "show me the raw diff" needs exactly these
   * bytes, and identity already hashes it — so re-reading it from somewhere else could
   * only disagree. Empty for a file whose producer rendered no patch at all.
   */
  patch: string;
  /**
   * Row totals the diff parser measured for each layout. Carried rather than reduced from
   * hunk spans, because a parser may count rows that sit outside every hunk.
   */
  splitLineCount: number;
  unifiedLineCount: number;
  additionLines: string[];
  deletionLines: string[];
  lineMoveKinds?: {
    additionLines: Array<"moved" | null>;
    deletionLines: Array<"moved" | null>;
  };
  hunks: ReviewHunkV1[];
  /** Digest of every renderer-neutral fact above; equal content means equal identity. */
  contentIdentity: string;
  /**
   * Opaque identity of the content backing this file's expandable source. State derived
   * from that content survives a reload only while this value is unchanged.
   */
  sourceIdentity?: string;
  /**
   * True when the source reader vouched for `sourceIdentity` with its own cache key, so
   * the full source cannot have changed behind an unchanged identity. Loaded source text
   * survives a reload only when attested; expansion state needs only the identity, since
   * gap geometry is a fact of the diff content alone.
   */
  sourceAttested?: boolean;
}

export interface ReviewDocumentV1 {
  files: ReviewFileV1[];
}
