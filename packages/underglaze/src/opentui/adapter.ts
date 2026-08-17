/**
 * Bridges underglaze's rasterizer to OpenTUI's image pipeline.
 *
 * OpenTUI already owns everything below the pixels: it probes `kitty_graphics`
 * at runtime, decodes and resizes natively, and falls back across kitty, sixel,
 * and block glyphs on its own. What it has no equivalent for is a rasterizer —
 * nothing in OpenTUI draws a gradient, a rounded corner, or a soft shadow.
 *
 * So this adapter deliberately does not reach for underglaze's own protocol,
 * capability, or blocks backends. Those exist for consumers writing to a raw
 * stream; under OpenTUI they would be a second, competing implementation of
 * transport that OpenTUI does better. underglaze draws, OpenTUI delivers.
 *
 * The seam is PNG bytes, which is `ImageRenderable`'s public `source` type. That
 * costs an encode and a native decode per redraw — cheap for chrome, which
 * changes on resize and theme rather than per frame — and in exchange it uses
 * only the documented surface, so it does not break when internals move.
 */
import type { TerminalCapabilities } from "@opentui/core";
import { imageBackend } from "../backend/image";
import type { GraphicsSupport, TerminalCapability } from "../capability/detect";
import type { Multiplexer } from "../protocol/passthrough";
import { encodePng } from "../raster/png";
import type { Pixmap } from "../raster/pixmap";
import { createSurface, type Surface } from "../scene/surface";

/**
 * Encodes a surface as PNG bytes for `ImageRenderable`'s `source`.
 *
 * Returns a `Uint8Array` rather than a Buffer because that is what OpenTUI's
 * `ImageSource` union names, and Buffer is a Node-only subclass of it.
 */
export function toImageSource(surface: Surface): Uint8Array {
  return new Uint8Array(surface.toPng());
}

/** Encodes a bare pixmap, for atlas output that never went through a Surface. */
export function pixmapToImageSource(pixmap: Pixmap): Uint8Array {
  return new Uint8Array(encodePng(pixmap));
}

/** Maps OpenTUI's multiplexer enum onto underglaze's. */
function toMultiplexer(value: TerminalCapabilities["multiplexer"]): Multiplexer {
  const name = String(value).toLowerCase();
  if (name.includes("tmux")) return "tmux";
  if (name.includes("screen")) return "screen";
  return "none";
}

/**
 * Converts OpenTUI's runtime capability probe into a underglaze capability record.
 *
 * This is strictly better than underglaze's own environment sniffing: OpenTUI
 * negotiates with the terminal rather than guessing from variables, so
 * `kitty_graphics` is an answer instead of an inference. Prefer this whenever a
 * renderer is available.
 *
 * `magnification` stays `unknown`, as it does everywhere. OpenTUI does not
 * report the resampling filter either, because no terminal does.
 */
export function fromOpenTuiCapabilities(capabilities: TerminalCapabilities): TerminalCapability {
  const graphics: GraphicsSupport = capabilities.kitty_graphics ? "kitty" : "none";
  return {
    terminal: "opentui",
    graphics,
    magnification: "unknown",
    multiplexer: toMultiplexer(capabilities.multiplexer),
    needsPassthrough: toMultiplexer(capabilities.multiplexer) !== "none",
    trueColor: capabilities.rgb,
  };
}

/**
 * Reports whether drawing chrome as pixels is worth it for this terminal.
 *
 * When neither kitty graphics nor sixel is available, OpenTUI would render the
 * image as block glyphs — two colors per cell, which is exactly what chrome
 * cannot survive. A caller is usually better off skipping the chrome layer
 * entirely and letting its ordinary box borders show than shipping a blocky
 * approximation of a gradient.
 */
export function chromeIsWorthwhile(capabilities: TerminalCapabilities | null): boolean {
  if (!capabilities) return false;
  return capabilities.kitty_graphics || capabilities.sixel;
}

export interface ChromeLayerOptions {
  /** Cell grid the chrome covers. */
  cols: number;
  rows: number;
  /** Pixel size of one cell; OpenTUI resizes to fit, so this sets detail, not layout. */
  cellWidth?: number;
  cellHeight?: number;
}

/**
 * Rebuilds chrome for a given size and hands back bytes plus the size drawn.
 *
 * Callers memoize on `cols`/`rows`/theme and only call this when one changes;
 * that is the whole redraw policy, since chrome is static between those events.
 * The backend is pinned to the image target because OpenTUI does the delivering
 * — picking a terminal backend here would emit escapes OpenTUI never asked for.
 */
export function renderChromeLayer(
  options: ChromeLayerOptions,
  draw: (surface: Surface) => void,
): { source: Uint8Array; cols: number; rows: number } {
  const surface = createSurface({
    cols: options.cols,
    rows: options.rows,
    cellWidth: options.cellWidth,
    cellHeight: options.cellHeight,
    backend: imageBackend(),
  });
  draw(surface);
  return { source: toImageSource(surface), cols: options.cols, rows: options.rows };
}
