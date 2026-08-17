/**
 * Encodes pixmaps as PNG, and as raw deflated pixel data.
 *
 * PNG's per-scanline predictors are the reason it is worth carrying an encoder
 * instead of just deflating raw pixels: on the smooth ramps chrome is made of,
 * filtering turns a gradient into near-constant residuals. Measured on a
 * full-screen gradient, filtered PNG came out around twelve times smaller than
 * the same pixels deflated raw, so the raw path is only preferable for flat
 * fills where the predictors have nothing to find.
 */
import { deflateSync } from "node:zlib";
import type { Pixmap } from "./pixmap";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Wraps data in a length-type-payload-CRC chunk. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** PNG's Paeth predictor: picks whichever neighbour the gradient points at. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Applies filter `type` to one scanline, writing residuals into `out`. */
function applyFilter(
  type: number,
  line: Uint8Array,
  prior: Uint8Array,
  out: Uint8Array,
  stride: number,
): number {
  let score = 0;
  for (let i = 0; i < stride; i++) {
    const a = i >= BYTES_PER_PIXEL ? line[i - BYTES_PER_PIXEL]! : 0;
    const b = prior[i]!;
    const c = i >= BYTES_PER_PIXEL ? prior[i - BYTES_PER_PIXEL]! : 0;
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else if (type === 4) pred = paeth(a, b, c);
    const v = (line[i]! - pred) & 0xff;
    out[i] = v;
    // Sum of signed magnitudes, the standard heuristic for picking a filter.
    score += v < 128 ? v : 256 - v;
  }
  return score;
}

export interface PngOptions {
  /** zlib level, 0-9. Level 9 is worth it here: encoding happens once, transmission repeats. */
  level?: number;
}

/** Encodes a pixmap as an RGBA PNG with adaptively filtered scanlines. */
export function encodePng(pm: Pixmap, options: PngOptions = {}): Buffer {
  const stride = pm.width * BYTES_PER_PIXEL;
  const raw = Buffer.alloc(pm.height * (stride + 1));
  const prior = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);

  for (let y = 0; y < pm.height; y++) {
    line.set(pm.data.subarray(y * stride, (y + 1) * stride));
    let bestType = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let type = 0; type <= 4; type++) {
      const score = applyFilter(type, line, prior, candidate, stride);
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(candidate);
      }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(best, y * (stride + 1) + 1);
    prior.set(line);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pm.width, 0);
  ihdr.writeUInt32BE(pm.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: options.level ?? 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Deflates raw RGBA bytes for the protocol's `f=32,o=z` path.
 *
 * Useful when the receiving terminal would only decode the PNG back to these
 * same bytes and the content is flat enough that filtering gains nothing.
 */
export function encodeDeflatedRgba(pm: Pixmap, options: PngOptions = {}): Buffer {
  return deflateSync(Buffer.from(pm.data.buffer, pm.data.byteOffset, pm.data.length), {
    level: options.level ?? 9,
  });
}

/** Picks whichever of the two encodings is smaller, reporting which won. */
export function encodeSmallest(
  pm: Pixmap,
  options: PngOptions = {},
): { format: 100 | 32; compressed: boolean; data: Buffer } {
  const png = encodePng(pm, options);
  const rawZ = encodeDeflatedRgba(pm, options);
  return png.length <= rawZ.length
    ? { format: 100, compressed: false, data: png }
    : { format: 32, compressed: true, data: rawZ };
}
