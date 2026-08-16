/**
 * Renders pixels through the kitty graphics protocol.
 *
 * The scene is transmitted as one image and placed to cover the cell grid.
 * Placing at a negative z-index puts it under the text layer, which is the
 * arrangement this library is built around: chrome is drawn in pixels, and the
 * terminal keeps drawing real, selectable text on top of it.
 */
import { detectCapability, type TerminalCapability } from "../capability/detect";
import { encodeDelete, encodePlace, encodeTransmit } from "../protocol/escapes";
import { wrapForMultiplexer } from "../protocol/passthrough";
import { encodeSmallest } from "../raster/png";
import { downscale, type Pixmap } from "../raster/pixmap";
import type { Backend, CellGeometry, RenderOutput } from "./types";

const ESC = String.fromCharCode(0x1b);

export interface KittyBackendOptions {
  /** Image id this backend owns. Reusing one id lets each frame replace the last. */
  imageId?: number;
  /** Stacking order; negative draws beneath text. */
  z?: number;
  /** Top-left cell to place at. */
  column?: number;
  row?: number;
  /**
   * Divisor applied to the source before transmission.
   *
   * Only worth raising when the terminal is known to magnify smoothly; see
   * `chooseSourceScale`. Left at 1 the image is sent at native resolution.
   */
  sourceScale?: number;
  /** Deletes the previous placement of this id before drawing, avoiding stacked ghosts. */
  replace?: boolean;
  /** Capability record used to decide multiplexer wrapping. Detected when omitted. */
  capability?: TerminalCapability;
}

/**
 * Builds a kitty graphics backend.
 *
 * The returned output is a single string: escape sequences in the order they
 * must be written. Callers own the actual write so this stays free of I/O.
 */
export function kittyBackend(options: KittyBackendOptions = {}): Backend {
  const imageId = options.imageId ?? 1;
  const z = options.z ?? -1;
  const scale = Math.max(1, Math.floor(options.sourceScale ?? 1));
  const capability = options.capability ?? detectCapability();

  return {
    name: "kitty",
    render(pixmap: Pixmap, geometry: CellGeometry): RenderOutput {
      const source = scale > 1 ? downscale(pixmap, scale) : pixmap;
      const encoded = encodeSmallest(source);

      const parts: string[] = [];
      if (options.replace) parts.push(encodeDelete({ kind: "id", id: imageId }));
      parts.push(
        ...encodeTransmit(encoded.data, {
          id: imageId,
          format: encoded.format,
          compressed: encoded.compressed,
          width: encoded.format === 100 ? undefined : source.width,
          height: encoded.format === 100 ? undefined : source.height,
          // Responses would otherwise land in the input stream and be read as keys.
          quiet: 2,
        }),
      );
      parts.push(
        encodePlace({
          id: imageId,
          cols: geometry.cols,
          rows: geometry.rows,
          z,
          keepCursor: true,
          quiet: 2,
        }),
      );

      const wrapped = parts.map((seq) => wrapForMultiplexer(seq, capability.multiplexer));
      // Position the cursor once, before the placement, so the image lands where asked.
      const move = `${ESC}[${(options.row ?? 0) + 1};${(options.column ?? 0) + 1}H`;
      return { kind: "terminal", data: move + wrapped.join("") };
    },
  };
}

/** Escape sequence that clears every image this backend may have placed. */
export function clearAllImages(capability: TerminalCapability = detectCapability()): string {
  return wrapForMultiplexer(encodeDelete({ kind: "all" }, true), capability.multiplexer);
}
