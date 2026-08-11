export const REVIEW_DOCUMENT_VERSION = 1 as const;

export type ReviewDocumentGeneration = string;
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
  preferred?: ReviewLineAddressV1;
  /** Every hunk whose old or new range intersects the note, in file order. */
  intersectingHunkIndices: number[];
  /** The one hunk used for navigation and rendering ownership. */
  ownerHunkIndex?: number;
}

export type ReviewNoteSourceV1 = "ai" | "agent" | "user";
export type ReviewNoteOriginV1 = "sidecar" | "live-agent" | "user";

export interface ReviewNoteV1 {
  id: string;
  source: ReviewNoteSourceV1;
  origin: ReviewNoteOriginV1;
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

export interface ReviewHunkV1 {
  index: number;
  collapsedBefore: number;
  splitLineCount: number;
  splitLineStart: number;
  unifiedLineCount: number;
  unifiedLineStart: number;
  additionCount: number;
  additionStart: number;
  additionLines: number;
  deletionCount: number;
  deletionStart: number;
  deletionLines: number;
  deletionLineIndex: number;
  additionLineIndex: number;
  hunkContent: Array<ReviewContextBlockV1 | ReviewChangeBlockV1>;
  hunkSpecs?: string;
  hunkContext?: string;
  noEOFCRAdditions: boolean;
  noEOFCRDeletions: boolean;
}

export interface ReviewPatchResourceDescriptorV1 {
  id: string;
  kind: "patch";
  generation: ReviewDocumentGeneration;
  fileKey: string;
  contentType: "text/x-diff; charset=utf-8";
  byteLength: number;
  digest: string;
}

export interface ReviewSourceResourceDescriptorV1 {
  id: string;
  kind: "source";
  generation: ReviewDocumentGeneration;
  fileKey: string;
  side: ReviewSide;
  contentType: "text/plain; charset=utf-8";
  sourceIdentity: string;
  byteLength?: number;
  digest?: string;
}

export interface ReviewCanonicalFileResourceDescriptorV1 {
  id: string;
  kind: "canonical-file";
  generation: ReviewDocumentGeneration;
  fileKey: string;
  contentType: "application/vnd.hunk.review-file+json; charset=utf-8";
  byteLength: number;
  digest: string;
}

export type ReviewResourceDescriptorV1 =
  | ReviewPatchResourceDescriptorV1
  | ReviewSourceResourceDescriptorV1
  | ReviewCanonicalFileResourceDescriptorV1;

export interface ReviewExpandedContextV1 {
  gapId: string;
  side: ReviewSide;
  oldRange: ReviewLineRange;
  newRange: ReviewLineRange;
  sourceResourceId: string;
}

export interface ReviewFileV1 {
  key: string;
  /** Transitional terminal-model id; never use it for generation reconciliation. */
  runtimeId: string;
  path: string;
  previousPath?: string;
  changeKind: ReviewFileChangeKind;
  language?: string;
  agentSummary?: string;
  stats: { additions: number; deletions: number; truncated: boolean };
  flags: { untracked: boolean; binary: boolean; tooLarge: boolean; partial: boolean };
  patchResourceId: string;
  canonicalResourceId: string;
  sourceResourceIds: Partial<Record<ReviewSide, string>>;
  additionLines: string[];
  deletionLines: string[];
  lineMoveKinds?: {
    additionLines: Array<"moved" | null>;
    deletionLines: Array<"moved" | null>;
  };
  hunks: ReviewHunkV1[];
  notes: ReviewNoteV1[];
  expandedContext: ReviewExpandedContextV1[];
}

export interface ReviewDocumentV1 {
  version: typeof REVIEW_DOCUMENT_VERSION;
  generation: ReviewDocumentGeneration;
  documentIdentity: string;
  changesetId: string;
  sourceLabel: string;
  title: string;
  summary?: string;
  agentSummary?: string;
  files: ReviewFileV1[];
  resources: ReviewResourceDescriptorV1[];
}

/** Serialization-safe document plus eagerly or lazily materialized generation resources. */
export interface ReviewDocumentProjectionV1 {
  document: ReviewDocumentV1;
  /** Materialized bytes by resource id; canonical files are intentionally absent until read. */
  resourceContents: Record<string, string>;
}
