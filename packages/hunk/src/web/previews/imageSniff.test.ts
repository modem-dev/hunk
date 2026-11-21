import { describe, expect, test } from "bun:test";
import {
  headerImageSize,
  isPreviewImagePath,
  PREVIEW_IMAGE_LIMITS,
  PREVIEW_IMAGE_MIMES,
  previewDisplaySize,
  previewImageRefusal,
  sniffPreviewImageMime,
  type PreviewImageMime,
} from "./imageSniff";

/** Build bytes from numbers and ASCII strings. */
const bytes = (...values: Array<number | string>) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === "string"
        ? Array.from(value, (character) => character.charCodeAt(0))
        : [value],
    ),
  );

/** Little-endian bytes of an unsigned integer. */
const le = (value: number, length: number) =>
  Array.from({ length }, (_unused, index) => Math.floor(value / 256 ** index) % 256);

/** Big-endian bytes of an unsigned integer. */
const be = (value: number, length: number) => le(value, length).reverse();

/** A PNG header through `IHDR` declaring `width × height`. */
function pngTestHeader(width: number, height: number) {
  return bytes(
    0x89,
    "PNG",
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be(13, 4),
    "IHDR",
    ...be(width, 4),
    ...be(height, 4),
    8,
    6,
    0,
    0,
    0,
  );
}

/** A JPEG with an APP0 segment, a DQT segment, and an SOF segment of the given marker. */
function jpegTestHeader(width: number, height: number, sofMarker = 0xc0) {
  return bytes(
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be(16, 2),
    "JFIF",
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xff,
    0xdb,
    ...be(4, 2),
    0,
    0,
    0xff,
    sofMarker,
    ...be(11, 2),
    8,
    ...be(height, 2),
    ...be(width, 2),
    1,
    1,
    0x11,
    0,
  );
}

/** A 40-byte BMP info header declaring `width × height`. */
function dibTestHeader(width: number, height: number) {
  return [
    ...le(40, 4),
    ...le(width >>> 0, 4),
    ...le(height >>> 0, 4),
    ...le(1, 2),
    ...le(32, 2),
    ...le(0, 24),
  ];
}

/** Sniff and read the size in one step, as the preview does. */
function sniffedTestSize(input: Uint8Array) {
  const mime = sniffPreviewImageMime(input);
  return mime ? headerImageSize(input, mime) : undefined;
}

describe("image previews", () => {
  test("only raster image extensions are candidates", () => {
    expect(isPreviewImagePath("assets/logo.PNG")).toBe(true);
    expect(isPreviewImagePath("a/b.ico")).toBe(true);
    expect(isPreviewImagePath("a/b.svg")).toBe(false);
    expect(isPreviewImagePath("a/b.avif")).toBe(false);
    expect(isPreviewImagePath("a/b.pdf")).toBe(false);
    expect(isPreviewImagePath("png")).toBe(false);
    expect(isPreviewImagePath(".png")).toBe(false);
  });

  test("the type comes from the signature, never the path", () => {
    expect(sniffPreviewImageMime(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      "image/png",
    );
    expect(sniffPreviewImageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffPreviewImageMime(bytes("GIF89a", 1, 0, 1, 0))).toBe("image/gif");
    expect(sniffPreviewImageMime(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("image/webp");
    // A PDF, an HTML page, and a script named like an image are not images.
    expect(sniffPreviewImageMime(bytes("%PDF-1.7"))).toBeUndefined();
    expect(sniffPreviewImageMime(bytes("<html><script>alert(1)</script>"))).toBeUndefined();
    expect(sniffPreviewImageMime(bytes("alert(1)//<svg>"))).toBeUndefined();
    expect(sniffPreviewImageMime(new Uint8Array())).toBeUndefined();
  });

  test("never accepts SVG or AVIF, so neither can become a blob", () => {
    const svg = bytes(
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(sniffPreviewImageMime(svg)).toBeUndefined();
    expect(sniffPreviewImageMime(bytes("<svg onload=alert(1)>"))).toBeUndefined();
    expect(sniffPreviewImageMime(bytes(0, 0, 0, 0x1c, "ftypavif"))).toBeUndefined();
    expect(PREVIEW_IMAGE_MIMES.has("image/svg+xml")).toBe(false);
    expect(PREVIEW_IMAGE_MIMES.has("image/avif")).toBe(false);
    for (const mime of PREVIEW_IMAGE_MIMES) {
      expect([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/x-icon",
      ]).toContain(mime);
    }
  });
});

describe("headerImageSize", () => {
  test("reads PNG and GIF sizes", () => {
    expect(sniffedTestSize(pngTestHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(sniffedTestSize(bytes("GIF89a", 16, 0, 9, 0))).toEqual({ width: 16, height: 9 });
  });

  test("reads a JPEG's size from its first SOF segment, past other segments and fill bytes", () => {
    expect(sniffedTestSize(jpegTestHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    // Progressive (SOF2) frames count too.
    expect(sniffedTestSize(jpegTestHeader(30_000, 30_000, 0xc2))).toEqual({
      width: 30_000,
      height: 30_000,
    });
  });

  test("does not mistake DHT, JPG, or DAC markers for frames", () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      expect(sniffedTestSize(jpegTestHeader(10, 10, marker))).toBeUndefined();
    }
  });

  test("gives up on a JPEG that reaches start-of-scan before a frame, or defers its height", () => {
    expect(sniffedTestSize(bytes(0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6))).toBeUndefined();
    expect(sniffedTestSize(jpegTestHeader(100, 0))).toBeUndefined();
  });

  test("reads all three WebP headers", () => {
    const riff = (chunk: string, payload: number[]) =>
      bytes("RIFF", ...le(0, 4), "WEBP", chunk, ...le(payload.length, 4), ...payload);
    // Lossy: frame tag, start code, 14-bit sizes (scale bits set and ignored).
    expect(
      sniffedTestSize(
        riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le(0xc000 | 400, 2), ...le(0x4000 | 300, 2)]),
      ),
    ).toEqual({ width: 400, height: 300 });
    // Lossless: signature 0x2f, then width-1 and height-1 in 14 bits each.
    const bits = (640 - 1) | ((480 - 1) << 14);
    expect(sniffedTestSize(riff("VP8L", [0x2f, ...le(bits, 4)]))).toEqual({
      width: 640,
      height: 480,
    });
    // Extended: flags, reserved, then 24-bit canvas width-1 and height-1.
    expect(
      sniffedTestSize(riff("VP8X", [0x10, 0, 0, 0, ...le(29_999, 3), ...le(29_999, 3)])),
    ).toEqual({ width: 30_000, height: 30_000 });
    // A lossy frame without its start code is not trusted.
    expect(sniffedTestSize(riff("VP8 ", [0, 0, 0, 0, 0, 0, 1, 0, 1, 0]))).toBeUndefined();
    expect(sniffedTestSize(riff("ALPH", [0, 0, 0, 0]))).toBeUndefined();
  });

  test("reads BMP info and core headers, taking the magnitude of a top-down height", () => {
    const bmp = (dib: number[]) => bytes("BM", ...le(0, 4), 0, 0, 0, 0, ...le(54, 4), ...dib);
    expect(sniffedTestSize(bmp(dibTestHeader(800, -600)))).toEqual({ width: 800, height: 600 });
    expect(
      sniffedTestSize(bmp([...le(12, 4), ...le(32, 2), ...le(16, 2), 1, 0, 24, 0, ...le(0, 8)])),
    ).toEqual({ width: 32, height: 16 });
    // An unknown DIB header size is unreadable.
    expect(sniffedTestSize(bmp([...le(20, 4), ...le(0, 20)]))).toBeUndefined();
  });

  test("reads every ICO entry and the image it points to, so a lying directory cannot hide a huge PNG", () => {
    const png = pngTestHeader(30_000, 30_000);
    const dib = dibTestHeader(16, 32);
    const directoryEnd = 6 + 16 * 2;
    const ico = bytes(
      0,
      0,
      1,
      0,
      ...le(2, 2),
      16,
      16,
      0,
      0,
      ...le(1, 2),
      ...le(32, 2),
      ...le(dib.length, 4),
      ...le(directoryEnd, 4),
      // The second entry claims 32 × 32 but embeds a PNG declaring 30000 × 30000.
      32,
      32,
      0,
      0,
      ...le(1, 2),
      ...le(32, 2),
      ...le(png.length, 4),
      ...le(directoryEnd + dib.length, 4),
      ...dib,
      ...png,
    );
    expect(sniffedTestSize(ico)).toEqual({ width: 30_000, height: 30_000 });
    // An entry whose image lies outside the file makes the whole icon unreadable.
    const dangling = bytes(
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      32,
      0,
      0,
      0,
      0,
      0,
      ...le(0xffffff00, 4),
    );
    expect(sniffedTestSize(dangling)).toBeUndefined();
  });

  test("returns nothing, and never throws, on truncated headers of every format", () => {
    const full: Record<PreviewImageMime, Uint8Array> = {
      "image/png": pngTestHeader(10, 10),
      "image/jpeg": jpegTestHeader(10, 10),
      "image/gif": bytes("GIF89a", 10, 0, 10, 0),
      "image/webp": bytes(
        "RIFF",
        ...le(0, 4),
        "WEBPVP8X",
        ...le(10, 4),
        0,
        0,
        0,
        0,
        ...le(9, 3),
        ...le(9, 3),
      ),
      "image/bmp": bytes("BM", ...le(0, 12), ...dibTestHeader(10, 10)),
      "image/x-icon": bytes(
        0,
        0,
        1,
        0,
        1,
        0,
        1,
        1,
        0,
        0,
        1,
        0,
        32,
        0,
        ...le(40, 4),
        ...le(22, 4),
        ...dibTestHeader(1, 2),
      ),
    };
    for (const [mime, input] of Object.entries(full) as Array<[PreviewImageMime, Uint8Array]>) {
      expect(headerImageSize(input, mime)).toBeDefined();
      for (let length = 0; length < input.length; length += 1) {
        expect(() => headerImageSize(input.subarray(0, length), mime)).not.toThrow();
        const truncated = headerImageSize(input.subarray(0, length), mime);
        // BMP and ICO keep everything they need before their unused trailing fields.
        if (truncated !== undefined) expect(truncated).toEqual(headerImageSize(input, mime)!);
      }
    }
  });

  test("survives hostile JPEG segment lengths and endless fill bytes", () => {
    expect(sniffedTestSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBeUndefined();
    expect(sniffedTestSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff))).toBeUndefined();
    expect(sniffedTestSize(Uint8Array.from({ length: 100_000 }, () => 0xff))).toBeUndefined();
    const random = Uint8Array.from({ length: 4096 }, (_unused, index) => (index * 7919) % 256);
    for (const mime of PREVIEW_IMAGE_MIMES) {
      expect(() => headerImageSize(random, mime as PreviewImageMime)).not.toThrow();
    }
  });
});

describe("previewImageRefusal", () => {
  test("refuses images past the side or pixel limit with their size", () => {
    expect(previewImageRefusal({ width: 30_000, height: 30_000 })).toBe(
      "Image too large to preview: 30000 × 30000",
    );
    expect(previewImageRefusal({ width: PREVIEW_IMAGE_LIMITS.side + 1, height: 1 })).toContain(
      "too large",
    );
    // 10000 × 6000 is within the side limit but 60 megapixels.
    expect(previewImageRefusal({ width: 10_000, height: 6_000 })).toContain("too large");
    expect(
      previewImageRefusal({ width: PREVIEW_IMAGE_LIMITS.side, height: 3_000 }),
    ).toBeUndefined();
    expect(previewImageRefusal({ width: 64, height: 32 })).toBeUndefined();
    expect(previewImageRefusal({ width: 0, height: 32 })).toBeDefined();
  });
});

describe("previewDisplaySize", () => {
  test("enlarges small images by a whole factor and shrinks large ones to fit", () => {
    expect(previewDisplaySize(16, 16)).toEqual({ width: 128, height: 128 });
    expect(previewDisplaySize(64, 32)).toEqual({ width: 448, height: 224 });
    expect(previewDisplaySize(400, 300)).toEqual({ width: 400, height: 300 });
    expect(previewDisplaySize(4000, 1000)).toEqual({ width: 460, height: 115 });
    expect(previewDisplaySize(0, 10)).toEqual({ width: 0, height: 0 });
  });
});
