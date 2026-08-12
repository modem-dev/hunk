/**
 * Declares the value shapes every review consumer shares: files addressed by a stable
 * key rather than by renderer identity, and notes anchored to line ranges rather than
 * to rendered rows. Says nothing about how a review is drawn or transported.
 *
 * The document shapes carry only what the review store itself reads. The document
 * projection phase widens them with hunk geometry, canonical resources, and content
 * identity, so no consumer should treat them as the complete canonical file yet.
 */
import type { ReviewNoteSource } from "../types";

export type ReviewSide = "old" | "new";
export type ReviewLineRange = readonly [number, number];

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

export interface ReviewFileV1 {
  /** Stable semantic address for one reviewed file, independent of renderer identity. */
  key: string;
  /** Transitional renderer-model id; never use it for cross-generation reconciliation. */
  runtimeId: string;
  path: string;
  /** Hunk count only: hunk geometry belongs to the document projection. */
  hunkCount: number;
  /**
   * Opaque identity of the content backing this file's expandable source. State derived
   * from that content survives a reload only while this value is unchanged.
   */
  sourceIdentity?: string;
}

export interface ReviewDocumentV1 {
  files: ReviewFileV1[];
}
