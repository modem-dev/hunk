/** One vertical extent measured in terminal rows within a single coordinate space. */
export interface VerticalBounds {
  top: number;
  height: number;
}

/** One selected column extent on a visual row, in global review-stream columns (inclusive). */
export interface CopySelectedCellRange {
  /** Global column where the selection starts on this row. */
  startCol: number;
  /** Global column where the selection ends on this row (inclusive). */
  endCol: number;
}

/** Selection paint for one planned row and, when wrapped, each intersecting visual line. */
export interface CopySelectedRowRange extends CopySelectedCellRange {
  /** Per-line paint ranges; omitted entries are outside the selected visual-row interval. */
  visualLineRanges?: readonly (CopySelectedCellRange | undefined)[];
}

/** Resolve the selected columns for one visual line of a planned row. */
export function copySelectedRangeAtVisualLine(
  range: CopySelectedRowRange | undefined,
  visualLineIndex: number,
): CopySelectedCellRange | undefined {
  return range?.visualLineRanges ? range.visualLineRanges[visualLineIndex] : range;
}

/**
 * Shared geometry for one file section body.
 *
 * `bodyHeight` and every nested `top` value should use the same coordinate space, such as
 * section-body-relative rows or whole-stream rows.
 */
export interface SectionGeometry<THunkBounds extends VerticalBounds> {
  bodyHeight: number;
  hunkAnchorRows: Map<number, number>;
  hunkBounds: Map<number, THunkBounds>;
}
