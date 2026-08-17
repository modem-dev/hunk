/**
 * Antialiased rounded-rectangle drawing.
 *
 * Shapes are rasterized from a signed distance field rather than scanline
 * spans, which gives clean corners at any radius and makes strokes fall out as
 * a band around the same distance function. Antialiasing matters more here than
 * in a normal renderer: a soft edge is exactly the detail a block-glyph
 * fallback has to throw away, so it is the visible payoff of drawing in pixels.
 */
import { type Paint, type Rgba } from "./paint";
import { blendPixel, type Pixmap } from "./pixmap";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Signed distance from a point to a rounded rectangle's boundary.
 *
 * Negative inside, positive outside, zero on the edge.
 */
export function roundRectDistance(px: number, py: number, rect: Rect, radius: number): number {
  const r = Math.max(0, Math.min(radius, Math.min(rect.width, rect.height) / 2));
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = Math.abs(px - cx) - (rect.width / 2 - r);
  const dy = Math.abs(py - cy) - (rect.height / 2 - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

/** Converts a signed distance to pixel coverage, giving a one-pixel soft edge. */
export function coverageFromDistance(distance: number): number {
  return Math.min(Math.max(0.5 - distance, 0), 1);
}

/** Coverage of a rounded rectangle at a point. */
export function roundRectCoverage(px: number, py: number, rect: Rect, radius: number): number {
  return coverageFromDistance(roundRectDistance(px, py, rect, radius));
}

/** Expands a rect by `pad` on every side, for iteration bounds that include soft edges. */
function padded(rect: Rect, pad: number): Rect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/** Runs `visit` over the integer pixels a padded rect covers, clipped to the pixmap. */
function forEachPixel(
  pm: Pixmap,
  rect: Rect,
  pad: number,
  visit: (x: number, y: number) => void,
): void {
  const area = padded(rect, pad);
  const x0 = Math.max(0, Math.floor(area.x));
  const y0 = Math.max(0, Math.floor(area.y));
  const x1 = Math.min(pm.width - 1, Math.ceil(area.x + area.width));
  const y1 = Math.min(pm.height - 1, Math.ceil(area.y + area.height));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) visit(x, y);
  }
}

/** Samples a paint at a pixel's normalized position within a rect. */
function sample(paint: Paint, rect: Rect, x: number, y: number): Rgba {
  const u = rect.width <= 0 ? 0 : (x - rect.x) / rect.width;
  const v = rect.height <= 0 ? 0 : (y - rect.y) / rect.height;
  return paint(Math.min(Math.max(u, 0), 1), Math.min(Math.max(v, 0), 1));
}

/** Fills a rounded rectangle. */
export function fillRoundRect(pm: Pixmap, rect: Rect, radius: number, paint: Paint): void {
  forEachPixel(pm, rect, 2, (x, y) => {
    const cov = roundRectCoverage(x, y, rect, radius);
    if (cov <= 0) return;
    blendPixel(pm, x, y, sample(paint, rect, x, y), cov);
  });
}

/** Fills a rectangle with square corners. */
export function fillRect(pm: Pixmap, rect: Rect, paint: Paint): void {
  fillRoundRect(pm, rect, 0, paint);
}

/** Fills a shape whose ends are perfect semicircles. */
export function fillPill(pm: Pixmap, rect: Rect, paint: Paint): void {
  fillRoundRect(pm, rect, rect.height / 2, paint);
}

/**
 * Strokes a rounded rectangle just inside its boundary.
 *
 * Insetting by half the stroke width keeps the whole line within the shape's
 * declared bounds, which is what a panel border needs: an outside-aligned
 * stroke would bleed into whatever sits next to the panel.
 */
export function strokeRoundRect(
  pm: Pixmap,
  rect: Rect,
  radius: number,
  width: number,
  paint: Paint,
): void {
  if (width <= 0) return;
  const half = width / 2;
  const inset: Rect = {
    x: rect.x + half,
    y: rect.y + half,
    width: Math.max(0, rect.width - width),
    height: Math.max(0, rect.height - width),
  };
  const insetRadius = Math.max(0, radius - half);
  forEachPixel(pm, rect, 2, (x, y) => {
    const d = Math.abs(roundRectDistance(x, y, inset, insetRadius));
    const cov = coverageFromDistance(d - half);
    if (cov <= 0) return;
    blendPixel(pm, x, y, sample(paint, rect, x, y), cov);
  });
}

/**
 * Draws a one-pixel highlight along a shape's top edge only.
 *
 * This is the bevel that reads as "raised" in classic desktop chrome, and it is
 * the first detail lost to cell averaging, since it occupies a single pixel row.
 * The edge is found by testing where coverage begins going down each column,
 * so the highlight follows the corner curve instead of running straight across.
 */
export function topBevel(pm: Pixmap, rect: Rect, radius: number, paint: Paint): void {
  forEachPixel(pm, rect, 2, (x, y) => {
    const here = roundRectCoverage(x, y, rect, radius);
    if (here <= 0) return;
    // A pixel is on the top edge when the pixel above it is outside the shape.
    const above = roundRectCoverage(x, y - 1, rect, radius);
    if (above >= here) return;
    blendPixel(pm, x, y, sample(paint, rect, x, y), here - above);
  });
}
