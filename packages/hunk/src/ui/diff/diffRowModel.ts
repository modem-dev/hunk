/**
 * Declares the terminal diff row model: the row and span shapes every review surface
 * measures, windows, and paints.
 *
 * Kept as a leaf module so both the row builders (`diffRows.ts`) and their consumers —
 * column math, the highlight worker, geometry — can share these types without importing
 * the builders themselves.
 */
import type { ReviewGapPosition } from "../../core/review/expansion";
import type { DiffLineMoveKind } from "../../core/changeset/model";

export interface RenderSpan {
  text: string;
  fg?: string;
  bg?: string;
  /** Resolve paint-only foreground effects after cursor and copy-selection backgrounds apply. */
  transformFg?: (sourceFg: string | undefined, renderedBg: string) => string;
}

export interface SplitLineCell {
  kind: "context" | "addition" | "deletion" | "empty";
  sign: string;
  lineNumber?: number;
  moveKind?: DiffLineMoveKind;
  spans: RenderSpan[];
}

export interface StackLineCell {
  kind: "context" | "addition" | "deletion";
  sign: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  moveKind?: DiffLineMoveKind;
  spans: RenderSpan[];
}

/** One vocabulary for gap positions, shared with the core gap addressing it comes from. */
export type CollapsedGapPosition = ReviewGapPosition;

export type DiffRow =
  | {
      type: "collapsed";
      key: string;
      fileId: string;
      hunkIndex: number;
      text: string;
      // Where this gap sits relative to the surrounding hunks; "before" attaches to
      // the gap leading into hunkIndex, "trailing" sits after the final hunk.
      position: CollapsedGapPosition;
      // 1-based inclusive file-line ranges this gap covers on each side. Expansion
      // uses these to slice the file contents that fill the gap.
      oldRange: [number, number];
      newRange: [number, number];
    }
  | {
      type: "hunk-header";
      key: string;
      fileId: string;
      hunkIndex: number;
      text: string;
    }
  | {
      type: "split-line";
      key: string;
      fileId: string;
      hunkIndex: number;
      left: SplitLineCell;
      right: SplitLineCell;
      // True when this row was synthesized to fill an expanded collapsed gap.
      // Expanded rows carry the neighbor hunk's index for ordering but must not
      // count toward that hunk's bounds or anchor position.
      isExpansionRow?: true;
      /** Exact collapsed gap this synthesized row reveals. */
      expandedGapKey?: string;
    }
  | {
      type: "stack-line";
      key: string;
      fileId: string;
      hunkIndex: number;
      cell: StackLineCell;
      isExpansionRow?: true;
      /** Exact collapsed gap this synthesized row reveals. */
      expandedGapKey?: string;
    };
