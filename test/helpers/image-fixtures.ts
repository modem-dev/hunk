import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Encode a solid-color RGB PNG, small enough to keep image fixtures readable. */
export function createTestPng(width: number, height: number, [r, g, b]: [number, number, number]) {
  const row = new Uint8Array(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const pixels = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y++) pixels.set(row, y * row.length);

  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const out = new DataView(new ArrayBuffer(12 + data.length));
    out.setUint32(0, data.length);
    new Uint8Array(out.buffer).set(body, 4);
    out.setUint32(8 + data.length, Bun.hash.crc32(body));
    return new Uint8Array(out.buffer);
  };

  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, width);
  header.setUint32(4, height);
  // 8-bit depth, truecolor, default compression, filter, and no interlace.
  new Uint8Array(header.buffer).set([8, 2, 0, 0, 0], 8);

  return new Uint8Array([
    ...PNG_SIGNATURE,
    ...chunk("IHDR", new Uint8Array(header.buffer)),
    ...chunk("IDAT", deflateSync(pixels)),
    ...chunk("IEND", new Uint8Array()),
  ]);
}
