/**
 * The review conformance harness: one corpus, every consumer, the same answers.
 *
 * Import gates prove a consumer *may* use a shared primitive; they cannot prove it does.
 * This harness closes that gap. Each consumer of the shared review model registers an
 * adapter that projects a fixture into one normalized shape, and every adapter is checked
 * against the same hand-written expectations. A consumer that re-derives geometry instead
 * of consuming core fails here rather than drifting quietly
 * (`docs/browser-review-rebuild.md` § "Per-phase seam verification", rung 2).
 *
 * Two rules keep it honest:
 *
 * - Expectations are written **by hand from the semantics**, never captured from a
 *   primitive's output. A captured expectation follows a bug instead of catching it, and
 *   the adversarial fixtures exist precisely because the old copies got them wrong.
 * - The projection is renderer-neutral. Anything only one consumer can produce — rows,
 *   widths, DOM — stays out, or the corpus stops being comparable.
 */
import type {
  ReviewPublicationAddress,
  ReviewPublicationOrder,
} from "../../packages/hunk/src/core/review/generationOrder";
import type { ReviewIntent } from "../../packages/hunk/src/core/review/intents";
import type { ReviewSelectionScope } from "../../packages/hunk/src/core/review/navigation";
import type { ReviewState } from "../../packages/hunk/src/core/review/state";
import type { ReviewNoteV1 } from "../../packages/hunk/src/core/review/types";
import type { HunkReviewPublicationBodyV1 } from "../../packages/hunk/src/session/reviewHttpProtocol";
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";

export interface ConformanceGap {
  gapId: string;
  oldRange: [number, number];
  newRange: [number, number];
  lineCount: number;
}

export interface ConformanceLineAddress {
  side: "old" | "new";
  line: number;
}

export interface ConformanceHunkRanges {
  oldRange: [number, number];
  newRange: [number, number];
}

/** One row an expanded gap reveals, as line labels plus the text beside them. */
export interface ConformanceExpandedRow {
  oldLine: number;
  newLine: number;
  text: string;
}

export interface ConformanceFileProjection {
  path: string;
  /** Every collapsed gap the file offers, in render order. */
  gaps: ConformanceGap[];
  /** Per-hunk inclusive extents on each side. */
  hunkRanges: ConformanceHunkRanges[];
  /** Where a note addressed to each whole hunk lands. */
  defaultNoteTargets: ConformanceLineAddress[];
  /** Present only for a file with nothing to render. */
  emptyDiffReason?: string;
  /** The rows the fixture's named gap reveals when expanded. */
  expandedRows?: ConformanceExpandedRow[];
}

export interface ReviewGeometryProjection {
  files: ConformanceFileProjection[];
}

export interface ConformanceExpansion {
  /** Index into the fixture's files. */
  fileIndex: number;
  gapId: string;
  /** Full source text the file's reader would return for the expanded side. */
  sourceText: string;
}

export interface ReviewGeometryFixture {
  id: string;
  /** Audit finding ids this fixture guards, e.g. `A1`. */
  findings: string[];
  /** What makes this input adversarial, in one line. */
  description: string;
  build: () => DiffFile[];
  expansion?: ConformanceExpansion;
  /** Hand-written from the semantics — never captured from a primitive. */
  expected: ReviewGeometryProjection;
}

/**
 * One consumer of the shared review model, as the harness sees it.
 *
 * A consumer joins by projecting fixtures through the code path it really uses, not by
 * calling core directly — the terminal adapter drives row building, a producer adapter
 * drives publication, a browser adapter drives its own projection.
 */
export interface ReviewGeometryConsumer {
  name: string;
  /** The phase that registered this consumer, for the gate ladder's records. */
  phase: string;
  project: (fixture: ReviewGeometryFixture) => ReviewGeometryProjection;
}

/** Renderer-neutral facts the authoritative extension snapshot must preserve. */
export interface ReviewSnapshotProjection {
  generation: string;
  stateRevision: number;
  files: Array<{ fileKey: string; contentIdentity: string }>;
  notes: Array<{
    id: string;
    parentId?: string;
    fileKey: string;
    resolution: "active" | "stale" | "orphaned";
    preferred?: ConformanceLineAddress;
    intersectingHunkIndices: number[];
    ownerHunkIndex?: number;
  }>;
}

/** One hand-authored complete-note fixture for snapshot consumers. */
export interface ReviewSnapshotFixture {
  id: string;
  findings: string[];
  description: string;
  generation: string;
  build: () => ReviewState;
  expected: ReviewSnapshotProjection;
}

/** One real projection of authoritative review snapshots. */
export interface ReviewSnapshotConsumer {
  name: string;
  phase: string;
  project: (fixture: ReviewSnapshotFixture) => ReviewSnapshotProjection;
}

/**
 * One position in a fixture's review, addressed the way a fixture can state it.
 *
 * `"vanished"` names a file key the document does not have — the reload case, where a
 * selection outlives the file it pointed at.
 */
export type ConformanceSelectionInput =
  | { file: number; hunkIndex: number }
  | { file: "vanished"; hunkIndex: number }
  | { file: null; hunkIndex: number };

/** One resolved position: an index into the fixture's files, or nothing addressable. */
export interface ConformanceSelection {
  file: number | null;
  hunkIndex: number;
}

export interface ConformanceReveal {
  anchor: "hunk" | "file-top" | "none";
  scrollToNote: boolean;
}

export interface ConformanceMove {
  scope: ReviewSelectionScope;
  delta: number;
  from: ConformanceSelectionInput;
}

/** Where one move landed and what it asked the viewport for; `to: null` means refused. */
export interface ConformanceMoveOutcome {
  to: ConformanceSelection | null;
  reveal?: ConformanceReveal;
}

export interface ReviewNavigationProjection {
  moves: ConformanceMoveOutcome[];
  /** What each declared starting point normalizes to under the fixture's filter. */
  normalizedSelections: ConformanceSelection[];
  /** The line a reveal targets, per hunk, per file. */
  revealTargets: Array<Array<ConformanceLineAddress | null>>;
}

export interface ReviewNavigationFixture {
  id: string;
  /** Audit finding ids this fixture guards, e.g. `B1`. */
  findings: string[];
  /** What makes this input adversarial, in one line. */
  description: string;
  build: () => DiffFile[];
  /** The filter as the reviewer typed it, applied before anything is planned. */
  filter?: string;
  /** Hunk indices carrying notes, by file index. */
  annotatedHunks?: Record<number, number[]>;
  /** File indices carrying review context; defaults to the files with annotated hunks. */
  annotatedFiles?: number[];
  moves: ConformanceMove[];
  selections: ConformanceSelectionInput[];
  /** Hand-written from the semantics — never captured from a primitive. */
  expected: ReviewNavigationProjection;
}

/**
 * One consumer of the shared navigation semantics.
 *
 * Registered separately from the geometry consumers because it answers different
 * questions, against the same rule: expectations are hand-written, and a consumer joins by
 * driving the code path it really uses.
 */
export interface ReviewNavigationConsumer {
  name: string;
  phase: string;
  project: (fixture: ReviewNavigationFixture) => ReviewNavigationProjection;
}

/**
 * One consumer of the publication-ordering contract.
 *
 * Registered separately because ordering is a different question from geometry or
 * navigation: given where a receiver is and what just arrived, what should it do? Every
 * consumer answers it by asking `classifyReviewPublication`, and this registry is how the
 * harness proves that rather than trusting it — a mirror with its own comparison would
 * disagree with the classifier on the fixtures the audit's C1 finding contributed.
 */
export interface ReviewOrderingConsumer {
  name: string;
  phase: string;
  classify: (
    current: ReviewPublicationAddress,
    incoming: ReviewPublicationAddress,
  ) => ReviewPublicationOrder;
}

/** What one wire consumer made of an action a client sent. */
export interface ReviewWireParseOutcome {
  accepted: boolean;
  /** The intent the action lowers to, when it was accepted. */
  intent?: ReviewIntent;
}

/**
 * One consumer of the wire schema.
 *
 * Two questions every tier must answer the same way: what an action means once parsed
 * (B12/B10), and whether a note may cross a boundary at all (D1). A consumer joins by
 * driving the code path it really uses.
 */
export interface ReviewWireConsumer {
  name: string;
  phase: string;
  parseAction: (action: Record<string, unknown>) => ReviewWireParseOutcome;
  acceptsNote: (note: ReviewNoteV1) => boolean;
}

/**
 * What one consumer made of framing an event, stated so two tiers can be compared.
 *
 * Deliberately about the shape of the exchange rather than its bytes: which frames went
 * out, how many of them a client may resume from, and whether the payload came back
 * intact. Sizes are arithmetic and belong to the protocol, not to a corpus.
 */
export interface ReviewEventFramingProjection {
  /** Frame names in order, with a run of chunk frames collapsed to one entry. */
  frames: string[];
  /** How many frames carry a resumable `id`. */
  resumableFrames: number;
  /** Whether reading the frames back yields the body that was framed. */
  roundTrips: boolean;
}

/** One publication to frame, and how small the sender's windows are while it does. */
export interface ReviewEventFixture {
  id: string;
  /** Audit finding ids this fixture guards, e.g. `C4`. */
  findings: string[];
  /** What makes this payload worth stating, in one line. */
  description: string;
  body: HunkReviewPublicationBodyV1;
  /**
   * Window size, either in bytes or relative to the payload.
   *
   * The relative forms are how a fixture pins the boundary both ends must agree on
   * without writing a byte count into the corpus.
   */
  chunkBytes: number | "payload-size" | "payload-size-minus-one";
  /** Hand-written from the semantics — never captured from a sender. */
  expected: ReviewEventFramingProjection;
}

/**
 * One consumer of the event contract.
 *
 * Registered separately because it answers a transport question rather than a semantic
 * one: given a publication and a window size, what goes on the wire and does it survive?
 * The shared protocol answers first and every tier that frames events joins beside it —
 * the HTTP surface here, a browser client's reader in Phase 5.
 */
export interface ReviewEventConsumer {
  name: string;
  phase: string;
  frame: (fixture: ReviewEventFixture) => Promise<ReviewEventFramingProjection>;
}

/** One action a client sends, and what the wire should make of it. */
export interface ReviewWireFixture {
  id: string;
  /** Audit finding ids this fixture guards, e.g. `B10`. */
  findings: string[];
  /** What makes this action worth stating, in one line. */
  description: string;
  action: Record<string, unknown>;
  /** Hand-written from the semantics — never captured from the parser. */
  expected: ReviewWireParseOutcome;
}
