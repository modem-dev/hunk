/**
 * A straight-alpha RGBA pixel buffer and the operations that touch pixels.
 *
 * This is the only module that indexes raw pixel memory; everything above it
 * works in shapes and paints. Coordinates are in device pixels, not cells, so
 * the rasterizer never needs to know the terminal's cell geometry.
 */

export interface Pixmap {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row-major. Clamped so blends cannot wrap. */
  data: Uint8ClampedArray;
}

export type Rgba = readonly [number, number, number, number];

/** Allocates a transparent pixmap. */
export function createPixmap(width: number, height: number): Pixmap {
  if (width <= 0 || height <= 0)
    throw new Error(`pixmap must be non-empty, got ${width}x${height}`);
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Returns whether a coordinate lies inside the buffer. */
export function contains(pm: Pixmap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < pm.width && y < pm.height;
}

/** Reads a pixel, clamping out-of-range coordinates to the edge. */
export function getPixel(pm: Pixmap, x: number, y: number): Rgba {
  const cx = Math.min(Math.max(x, 0), pm.width - 1);
  const cy = Math.min(Math.max(y, 0), pm.height - 1);
  const o = (cy * pm.width + cx) * 4;
  return [pm.data[o]!, pm.data[o + 1]!, pm.data[o + 2]!, pm.data[o + 3]!];
}

/** Writes a pixel, replacing whatever was there. Out-of-range writes are dropped. */
export function setPixel(pm: Pixmap, x: number, y: number, color: Rgba): void {
  if (!contains(pm, x, y)) return;
  const o = (y * pm.width + x) * 4;
  pm.data[o] = color[0];
  pm.data[o + 1] = color[1];
  pm.data[o + 2] = color[2];
  pm.data[o + 3] = color[3];
}

/**
 * Composites a color over the existing pixel using source-over.
 *
 * `coverage` scales the source alpha, which is how antialiased shape edges get
 * their partial contribution without a separate mask buffer.
 */
export function blendPixel(pm: Pixmap, x: number, y: number, color: Rgba, coverage = 1): void {
  if (!contains(pm, x, y)) return;
  const sa = (color[3] / 255) * coverage;
  if (sa <= 0) return;
  const o = (y * pm.width + x) * 4;
  if (sa >= 1) {
    pm.data[o] = color[0];
    pm.data[o + 1] = color[1];
    pm.data[o + 2] = color[2];
    pm.data[o + 3] = 255;
    return;
  }
  const da = pm.data[o + 3]! / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c++) {
    const src = color[c]!;
    const dst = pm.data[o + c]!;
    pm.data[o + c] = (src * sa + dst * da * (1 - sa)) / outA;
  }
  pm.data[o + 3] = outA * 255;
}

/** Fills the whole buffer with one opaque color. */
export function fillAll(pm: Pixmap, color: Rgba): void {
  for (let i = 0; i < pm.data.length; i += 4) {
    pm.data[i] = color[0];
    pm.data[i + 1] = color[1];
    pm.data[i + 2] = color[2];
    pm.data[i + 3] = color[3];
  }
}

/** Copies a pixmap, so a scene can be reused as a base for several renders. */
export function clonePixmap(pm: Pixmap): Pixmap {
  return { width: pm.width, height: pm.height, data: new Uint8ClampedArray(pm.data) };
}

/** Averages each f-by-f block into one pixel, reducing a source before transmission. */
export function downscale(pm: Pixmap, factor: number): Pixmap {
  if (factor <= 1) return clonePixmap(pm);
  const out = createPixmap(
    Math.max(1, Math.ceil(pm.width / factor)),
    Math.max(1, Math.ceil(pm.height / factor)),
  );
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= pm.width || sy >= pm.height) continue;
          const p = getPixel(pm, sx, sy);
          r += p[0];
          g += p[1];
          b += p[2];
          a += p[3];
          n++;
        }
      }
      if (n === 0) continue;
      setPixel(out, x, y, [r / n, g / n, b / n, a / n]);
    }
  }
  return out;
}

/** Crops a sub-rectangle, used to lift one sprite out of a packed atlas. */
export function cropPixmap(
  pm: Pixmap,
  x: number,
  y: number,
  width: number,
  height: number,
): Pixmap {
  const out = createPixmap(width, height);
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      setPixel(out, dx, dy, getPixel(pm, x + dx, y + dy));
    }
  }
  return out;
}
