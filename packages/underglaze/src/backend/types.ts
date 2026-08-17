/**
 * The contract every render target implements.
 *
 * A backend turns finished pixels into something a consumer can use. Keeping
 * this narrow is what lets one scene description reach a graphics-capable
 * terminal, a block-glyph fallback, and an image file without the drawing code
 * knowing which is in play — including in tests, where the image target gives
 * terminal UI something it normally lacks: a snapshot to diff.
 */
import type { Pixmap } from "../raster/pixmap";

/** Where a rendered scene ends up. */
export type RenderOutput = { kind: "terminal"; data: string } | { kind: "image"; data: Buffer };

/**
 * Pixel dimensions of one terminal cell, plus the grid size.
 *
 * Cell size is a property of the font and terminal, not of the content, so it
 * is supplied rather than assumed. Callers that cannot query it should use
 * `DEFAULT_CELL_GEOMETRY`, which is close enough for layout that only truly
 * pixel-exact art will notice.
 */
export interface CellGeometry {
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
}

/** A common 8x17 cell, matching many terminals at a typical default font size. */
export const DEFAULT_CELL_GEOMETRY: Omit<CellGeometry, "cols" | "rows"> = {
  cellWidth: 8,
  cellHeight: 17,
};

/** Pixel dimensions covered by a cell grid. */
export function pixelSize(geometry: CellGeometry): { width: number; height: number } {
  return {
    width: geometry.cols * geometry.cellWidth,
    height: geometry.rows * geometry.cellHeight,
  };
}

export interface Backend {
  readonly name: string;
  /**
   * Renders a pixmap covering the whole cell grid.
   *
   * Backends may assume the pixmap matches `pixelSize(geometry)`; the surface
   * that owns the pixmap guarantees it.
   */
  render(pixmap: Pixmap, geometry: CellGeometry): RenderOutput;
}
