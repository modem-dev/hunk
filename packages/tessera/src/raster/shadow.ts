/**
 * Soft drop shadows behind rounded rectangles.
 *
 * Shadows are built as a blurred coverage mask rather than by stamping a
 * pre-rendered sprite, so any shape and blur radius work without art assets.
 * They are also the clearest demonstration of what pixel output buys: a shadow
 * is pure low-frequency gradient, which compresses to almost nothing and which
 * a two-colors-per-cell fallback can only render as banding.
 */
import { parseColor, type ColorInput } from "./paint";
import { blendPixel, type Pixmap } from "./pixmap";
import { roundRectCoverage, type Rect } from "./shapes";

export interface ShadowOptions {
  /** Horizontal offset in pixels. */
  dx?: number;
  /** Vertical offset in pixels. */
  dy?: number;
  /** Blur radius in pixels; larger is softer and more expensive. */
  blur?: number;
  color?: ColorInput;
  /** Peak opacity at the shadow's center, 0 to 1. */
  opacity?: number;
}

/**
 * Runs a separable box blur in place.
 *
 * Three passes approximate a Gaussian closely enough that no banding is visible
 * at the radii chrome uses, and each pass is linear in the radius rather than
 * quadratic, which keeps a large soft shadow affordable.
 */
function boxBlur(mask: Float32Array, width: number, height: number, radius: number): void {
  if (radius <= 0) return;
  const scratch = new Float32Array(mask.length);
  const span = radius * 2 + 1;
  for (let pass = 0; pass < 3; pass++) {
    // Horizontal
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum += mask[row + Math.min(Math.max(k, 0), width - 1)]!;
      for (let x = 0; x < width; x++) {
        scratch[row + x] = sum / span;
        const drop = row + Math.min(Math.max(x - radius, 0), width - 1);
        const add = row + Math.min(Math.max(x + radius + 1, 0), width - 1);
        sum += mask[add]! - mask[drop]!;
      }
    }
    // Vertical
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += scratch[Math.min(Math.max(k, 0), height - 1) * width + x]!;
      }
      for (let y = 0; y < height; y++) {
        mask[y * width + x] = sum / span;
        const drop = Math.min(Math.max(y - radius, 0), height - 1) * width + x;
        const add = Math.min(Math.max(y + radius + 1, 0), height - 1) * width + x;
        sum += scratch[add]! - scratch[drop]!;
      }
    }
  }
}

/**
 * Draws a blurred shadow for a rounded rectangle.
 *
 * The mask is only built over the shape's neighbourhood, not the whole pixmap,
 * so cost tracks the shape's size rather than the surface's.
 */
export function dropShadow(
  pm: Pixmap,
  rect: Rect,
  radius: number,
  options: ShadowOptions = {},
): void {
  const dx = options.dx ?? 0;
  const dy = options.dy ?? 2;
  const blur = Math.max(0, Math.round(options.blur ?? 4));
  const color = parseColor(options.color ?? "#000");
  const opacity = Math.min(Math.max(options.opacity ?? 0.55, 0), 1);
  if (opacity <= 0) return;

  // Work in a local window big enough to hold the offset shape plus its blur tail.
  const margin = blur * 3 + 2;
  const originX = Math.floor(rect.x + dx - margin);
  const originY = Math.floor(rect.y + dy - margin);
  const width = Math.ceil(rect.width + margin * 2) + 1;
  const height = Math.ceil(rect.height + margin * 2) + 1;
  if (width <= 0 || height <= 0) return;

  const shifted: Rect = {
    x: rect.x + dx - originX,
    y: rect.y + dy - originY,
    width: rect.width,
    height: rect.height,
  };
  const mask = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      mask[y * width + x] = roundRectCoverage(x, y, shifted, radius);
    }
  }
  boxBlur(mask, width, height, blur);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const m = mask[y * width + x]!;
      if (m <= 0.002) continue;
      blendPixel(pm, originX + x, originY + y, color, m * opacity * (color[3] / 255));
    }
  }
}
