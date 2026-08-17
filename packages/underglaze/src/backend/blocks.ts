/**
 * Renders pixels as colored block glyphs, for terminals without graphics.
 *
 * Every variant here is bounded by the same wall: a cell can show exactly two
 * colors, a foreground and a background. Richer glyph repertoires buy more
 * subcell *shapes* — halves, quadrants, sextants — but never a third color, so
 * a smooth corner or a soft shadow cannot be represented at any glyph density.
 * Treat this as a lossy codec with a fixed, fairly low ceiling, not as parity
 * with the graphics path.
 */
import { getPixel, type Pixmap, type Rgba } from "../raster/pixmap";
import type { Backend, CellGeometry, RenderOutput } from "./types";

const ESC = String.fromCharCode(0x1b);
const RESET = `${ESC}[0m`;

/** How finely a cell is subdivided. Both are still two colors per cell. */
export type BlockStyle = "half" | "quadrant";

/**
 * Quadrant glyphs indexed by an occupancy bitmask.
 *
 * Bit 0 is upper-left, 1 upper-right, 2 lower-left, 3 lower-right; the glyph at
 * each index lights exactly those quadrants in the foreground color.
 */
const QUADRANT_GLYPHS = [
  " ",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
] as const;

const UPPER_HALF = "▀";

/** Perceptual weighting, used to decide which subcells group together. */
function luminance(color: Rgba): number {
  return color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
}

/** Averages a rectangle of pixels, compositing over black so alpha reads correctly. */
function averageRegion(pm: Pixmap, x0: number, y0: number, x1: number, y1: number): Rgba {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = getPixel(pm, x, y);
      const a = p[3] / 255;
      r += p[0] * a;
      g += p[1] * a;
      b += p[2] * a;
      n++;
    }
  }
  if (n === 0) return [0, 0, 0, 255];
  return [r / n, g / n, b / n, 255];
}

/** Mean of a set of colors. */
function meanColor(colors: Rgba[]): Rgba {
  if (colors.length === 0) return [0, 0, 0, 255];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of colors) {
    r += c[0];
    g += c[1];
    b += c[2];
  }
  return [r / colors.length, g / colors.length, b / colors.length, 255];
}

/** Emits SGR only when a color actually changes, which roughly halves the bytes. */
class SgrWriter {
  private lastFg = "";
  private lastBg = "";
  private out = "";

  /** Moves the cursor to the start of a row, 1-based as the terminal expects. */
  moveTo(row: number): void {
    this.out += `${ESC}[${row + 1};1H`;
    // Cursor movement does not reset SGR, but a new row is a natural place to
    // drop cached state so a partially drawn screen cannot inherit stale colors.
    this.lastFg = "";
    this.lastBg = "";
  }

  cell(glyph: string, fg: Rgba, bg: Rgba): void {
    const f = `${Math.round(fg[0])};${Math.round(fg[1])};${Math.round(fg[2])}`;
    const b = `${Math.round(bg[0])};${Math.round(bg[1])};${Math.round(bg[2])}`;
    if (f !== this.lastFg) {
      this.out += `${ESC}[38;2;${f}m`;
      this.lastFg = f;
    }
    if (b !== this.lastBg) {
      this.out += `${ESC}[48;2;${b}m`;
      this.lastBg = b;
    }
    this.out += glyph;
  }

  finish(): string {
    return this.out + RESET;
  }
}

/** Renders a cell as an upper-half block: two vertically stacked averages. */
function renderHalfCell(
  pm: Pixmap,
  cx: number,
  cy: number,
  geometry: CellGeometry,
): { glyph: string; fg: Rgba; bg: Rgba } {
  const x0 = cx * geometry.cellWidth;
  const y0 = cy * geometry.cellHeight;
  const mid = y0 + Math.floor(geometry.cellHeight / 2);
  return {
    glyph: UPPER_HALF,
    fg: averageRegion(pm, x0, y0, x0 + geometry.cellWidth, mid),
    bg: averageRegion(pm, x0, mid, x0 + geometry.cellWidth, y0 + geometry.cellHeight),
  };
}

/**
 * Renders a cell as a quadrant glyph.
 *
 * The four quadrant averages are split into two groups about their mean
 * luminance; each group collapses to one color. That is the best a two-color
 * cell can do, and it is why quadrants improve edges only slightly over halves.
 */
function renderQuadrantCell(
  pm: Pixmap,
  cx: number,
  cy: number,
  geometry: CellGeometry,
): { glyph: string; fg: Rgba; bg: Rgba } {
  const x0 = cx * geometry.cellWidth;
  const y0 = cy * geometry.cellHeight;
  const xm = x0 + Math.floor(geometry.cellWidth / 2);
  const ym = y0 + Math.floor(geometry.cellHeight / 2);
  const x1 = x0 + geometry.cellWidth;
  const y1 = y0 + geometry.cellHeight;

  const quads: Rgba[] = [
    averageRegion(pm, x0, y0, xm, ym),
    averageRegion(pm, xm, y0, x1, ym),
    averageRegion(pm, x0, ym, xm, y1),
    averageRegion(pm, xm, ym, x1, y1),
  ];
  const mean = quads.reduce((s, c) => s + luminance(c), 0) / quads.length;

  let mask = 0;
  const bright: Rgba[] = [];
  const dark: Rgba[] = [];
  quads.forEach((c, i) => {
    if (luminance(c) > mean) {
      mask |= 1 << i;
      bright.push(c);
    } else {
      dark.push(c);
    }
  });

  // A uniform cell has no bright group; fall back to a solid block of its color.
  if (bright.length === 0)
    return { glyph: QUADRANT_GLYPHS[15]!, fg: meanColor(quads), bg: meanColor(quads) };
  return { glyph: QUADRANT_GLYPHS[mask]!, fg: meanColor(bright), bg: meanColor(dark) };
}

/**
 * Builds a block-glyph backend.
 *
 * Output is absolutely positioned per row, so it repaints a region without
 * assuming anything about where the cursor was.
 */
export function blocksBackend(style: BlockStyle = "half"): Backend {
  return {
    name: `blocks:${style}`,
    render(pixmap: Pixmap, geometry: CellGeometry): RenderOutput {
      const writer = new SgrWriter();
      for (let cy = 0; cy < geometry.rows; cy++) {
        writer.moveTo(cy);
        for (let cx = 0; cx < geometry.cols; cx++) {
          const cell =
            style === "half"
              ? renderHalfCell(pixmap, cx, cy, geometry)
              : renderQuadrantCell(pixmap, cx, cy, geometry);
          writer.cell(cell.glyph, cell.fg, cell.bg);
        }
      }
      return { kind: "terminal", data: writer.finish() };
    },
  };
}
