/**
 * Renders a scene to a PNG buffer instead of a terminal.
 *
 * This exists so terminal UI can be snapshot-tested. Asserting on escape
 * sequences proves what was sent, not what it looks like; rendering the same
 * scene to an image gives a artifact a human can open and a test can diff,
 * without a PTY, a real terminal, or a screenshot harness.
 */
import { encodePng } from "../raster/png";
import type { Pixmap } from "../raster/pixmap";
import type { Backend, CellGeometry, RenderOutput } from "./types";

export interface ImageBackendOptions {
  /** zlib level; drop it for faster test runs where size does not matter. */
  level?: number;
  /** Integer magnification, so cell structure is legible when reviewing output. */
  zoom?: number;
}

/** Nearest-neighbour magnification, which keeps pixel boundaries crisp. */
function magnify(pm: Pixmap, zoom: number): Pixmap {
  if (zoom <= 1) return pm;
  const out: Pixmap = {
    width: pm.width * zoom,
    height: pm.height * zoom,
    data: new Uint8ClampedArray(pm.width * zoom * pm.height * zoom * 4),
  };
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / zoom);
    for (let x = 0; x < out.width; x++) {
      const sx = Math.floor(x / zoom);
      const src = (sy * pm.width + sx) * 4;
      const dst = (y * out.width + x) * 4;
      out.data[dst] = pm.data[src]!;
      out.data[dst + 1] = pm.data[src + 1]!;
      out.data[dst + 2] = pm.data[src + 2]!;
      out.data[dst + 3] = pm.data[src + 3]!;
    }
  }
  return out;
}

/** Builds a backend that returns PNG bytes. */
export function imageBackend(options: ImageBackendOptions = {}): Backend {
  return {
    name: "image",
    render(pixmap: Pixmap, _geometry: CellGeometry): RenderOutput {
      const zoomed = magnify(pixmap, Math.max(1, Math.floor(options.zoom ?? 1)));
      return { kind: "image", data: encodePng(zoomed, { level: options.level }) };
    },
  };
}
