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
import type { ReviewSelectionScope } from "../../src/core/review/navigation";
import type { DiffFile } from "../../src/core/types";

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

export interface ReviewConformanceProjection {
  files: ConformanceFileProjection[];
}

export interface ConformanceExpansion {
  /** Index into the fixture's files. */
  fileIndex: number;
  gapId: string;
  /** Full source text the file's reader would return for the expanded side. */
  sourceText: string;
}

export interface ReviewConformanceFixture {
  id: string;
  /** Audit finding ids this fixture guards, e.g. `A1`. */
  findings: string[];
  /** What makes this input adversarial, in one line. */
  description: string;
  build: () => DiffFile[];
  expansion?: ConformanceExpansion;
  /** Hand-written from the semantics — never captured from a primitive. */
  expected: ReviewConformanceProjection;
}

/**
 * One consumer of the shared review model, as the harness sees it.
 *
 * A consumer joins by projecting fixtures through the code path it really uses, not by
 * calling core directly — the terminal adapter drives row building, a producer adapter
 * drives publication, a browser adapter drives its own projection.
 */
export interface ReviewConformanceConsumer {
  name: string;
  /** The phase that registered this consumer, for the gate ladder's records. */
  phase: string;
  project: (fixture: ReviewConformanceFixture) => ReviewConformanceProjection;
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
