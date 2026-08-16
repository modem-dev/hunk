/**
 * The drawing surface consumers actually use.
 *
 * Coordinates are in cells, including fractional ones, because that is the unit
 * terminal layout is already expressed in; the surface converts to pixels using
 * the cell geometry it was given. Draw calls accumulate into one pixmap, which a
 * backend then turns into escape sequences or an image, so switching between a
 * graphics terminal, a block-glyph fallback, and a PNG snapshot changes nothing
 * about the drawing code.
 */
import { blocksBackend } from "../backend/blocks";
import { imageBackend } from "../backend/image";
import { kittyBackend } from "../backend/kitty";
import {
  DEFAULT_CELL_GEOMETRY,
  type Backend,
  type CellGeometry,
  type RenderOutput,
} from "../backend/types";
import { chooseSourceScale, detectCapability, type TerminalCapability } from "../capability/detect";
import { parseColor, solid, type ColorInput, type Paint } from "../raster/paint";
import { createPixmap, fillAll, type Pixmap } from "../raster/pixmap";
import { dropShadow, type ShadowOptions } from "../raster/shadow";
import { fillPill, fillRoundRect, strokeRoundRect, topBevel, type Rect } from "../raster/shapes";

/** A rectangle in cell units. Fractions are allowed and land on exact pixels. */
export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceOptions {
  cols: number;
  rows: number;
  cellWidth?: number;
  cellHeight?: number;
  /** Filled before any drawing; leave unset for a transparent surface. */
  background?: ColorInput;
  /** Defaults to whatever `autoBackend` picks for the current terminal. */
  backend?: Backend;
}

export interface PanelStyle {
  fill?: Paint | ColorInput;
  /** Corner radius in pixels, since radii read in pixels even when layout is in cells. */
  radius?: number;
  border?: { color: ColorInput; width?: number };
  shadow?: ShadowOptions;
  /** Adds a one-pixel highlight along the top edge. */
  bevel?: ColorInput;
}

/** Accepts either a paint function or a plain color. */
function toPaint(value: Paint | ColorInput | undefined, fallback: Paint): Paint {
  if (value === undefined) return fallback;
  return typeof value === "function" ? value : solid(value);
}

/**
 * Picks a backend for the current terminal.
 *
 * Anything short of confirmed graphics support falls back to block glyphs,
 * because emitting a graphics sequence to a terminal that does not understand it
 * dumps base64 across the screen — a far worse failure than degraded chrome.
 */
export function autoBackend(capability: TerminalCapability = detectCapability()): Backend {
  if (capability.graphics !== "kitty") return blocksBackend("half");
  return kittyBackend({
    capability,
    sourceScale: chooseSourceScale(capability),
    replace: true,
  });
}

export class Surface {
  readonly geometry: CellGeometry;
  private readonly pixmap: Pixmap;
  private readonly backend: Backend;

  constructor(options: SurfaceOptions) {
    this.geometry = {
      cols: options.cols,
      rows: options.rows,
      cellWidth: options.cellWidth ?? DEFAULT_CELL_GEOMETRY.cellWidth,
      cellHeight: options.cellHeight ?? DEFAULT_CELL_GEOMETRY.cellHeight,
    };
    this.pixmap = createPixmap(
      this.geometry.cols * this.geometry.cellWidth,
      this.geometry.rows * this.geometry.cellHeight,
    );
    this.backend = options.backend ?? autoBackend();
    if (options.background !== undefined) fillAll(this.pixmap, parseColor(options.background));
  }

  /** Converts a cell rectangle to device pixels. */
  toPixels(rect: CellRect): Rect {
    return {
      x: rect.x * this.geometry.cellWidth,
      y: rect.y * this.geometry.cellHeight,
      width: rect.width * this.geometry.cellWidth,
      height: rect.height * this.geometry.cellHeight,
    };
  }

  /** Clears the surface back to one color. */
  clear(color: ColorInput = [0, 0, 0, 0]): this {
    fillAll(this.pixmap, parseColor(color));
    return this;
  }

  /**
   * Draws a panel: optional shadow, fill, border, and top bevel, in that order.
   *
   * The ordering is fixed because it is the only one that looks right — a
   * shadow drawn after the fill would sit on top of it, and a bevel drawn before
   * the border would be overwritten by it.
   */
  panel(rect: CellRect, style: PanelStyle = {}): this {
    const px = this.toPixels(rect);
    const radius = style.radius ?? 0;
    if (style.shadow) dropShadow(this.pixmap, px, radius, style.shadow);
    fillRoundRect(this.pixmap, px, radius, toPaint(style.fill, solid("#1e1f26")));
    if (style.border) {
      strokeRoundRect(this.pixmap, px, radius, style.border.width ?? 1, solid(style.border.color));
    }
    if (style.bevel !== undefined) topBevel(this.pixmap, px, radius, solid(style.bevel));
    return this;
  }

  /** Draws a rectangle with square corners. */
  rect(rect: CellRect, fill: Paint | ColorInput): this {
    fillRoundRect(this.pixmap, this.toPixels(rect), 0, toPaint(fill, solid("#000")));
    return this;
  }

  /** Draws a fully rounded shape, the classic status chip or capsule button. */
  pill(rect: CellRect, style: PanelStyle = {}): this {
    const px = this.toPixels(rect);
    if (style.shadow) dropShadow(this.pixmap, px, px.height / 2, style.shadow);
    fillPill(this.pixmap, px, toPaint(style.fill, solid("#3a3d4a")));
    if (style.border) {
      strokeRoundRect(
        this.pixmap,
        px,
        px.height / 2,
        style.border.width ?? 1,
        solid(style.border.color),
      );
    }
    return this;
  }

  /**
   * Draws a track with a filled portion, sized by `value` from 0 to 1.
   *
   * Kept as a primitive because a progress bar's inner fill has to inset by the
   * track's border and re-derive its radius, which is fiddly to get right at
   * every size and easy to get subtly wrong by hand.
   */
  meter(
    rect: CellRect,
    value: number,
    style: { track?: ColorInput; fill?: Paint | ColorInput } = {},
  ): this {
    const px = this.toPixels(rect);
    fillPill(this.pixmap, px, solid(style.track ?? "#181920"));
    const inset = 2;
    const usable = Math.max(0, px.width - inset * 2);
    const filled = usable * Math.min(Math.max(value, 0), 1);
    if (filled <= 0) return this;
    const inner: Rect = {
      x: px.x + inset,
      y: px.y + inset,
      width: filled,
      height: Math.max(0, px.height - inset * 2),
    };
    fillPill(this.pixmap, inner, toPaint(style.fill, solid("#5cc98a")));
    return this;
  }

  /** Escape hatch for drawing directly into the pixel buffer. */
  draw(fn: (pixmap: Pixmap, geometry: CellGeometry) => void): this {
    fn(this.pixmap, this.geometry);
    return this;
  }

  /** Renders through the configured backend. */
  render(backend: Backend = this.backend): RenderOutput {
    return backend.render(this.pixmap, this.geometry);
  }

  /**
   * Renders to a terminal-writable string.
   *
   * Throws when the configured backend produces an image, since writing PNG
   * bytes to a terminal would corrupt the display rather than fail visibly.
   */
  toTerminal(backend: Backend = this.backend): string {
    const output = this.render(backend);
    if (output.kind !== "terminal") {
      throw new Error(`backend "${backend.name}" renders images, not terminal output`);
    }
    return output.data;
  }

  /** Renders to PNG bytes, for snapshots and for looking at what was drawn. */
  toPng(zoom = 1): Buffer {
    const output = this.render(imageBackend({ zoom }));
    if (output.kind !== "image") throw new Error("image backend did not produce image output");
    return output.data;
  }
}

/** Convenience constructor, so consumers need not import the class. */
export function createSurface(options: SurfaceOptions): Surface {
  return new Surface(options);
}
