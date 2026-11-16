/**
 * Decides whether a binary file is an image the page may preview, with what MIME type, and
 * whether its declared size is small enough to decode.
 *
 * Two checks decide the type, both required: the path names an image format (so a renamed
 * blob is not shown as a picture by accident), and the first bytes carry that family's
 * signature (so the path is never trusted alone). The MIME type always comes from the
 * signature, never from the path, and is the only type a preview `Blob` is ever given.
 *
 * Only raster formats from a fixed allow-list are accepted. SVG is refused: inside `<img>` it is
 * inert, but a `blob:` URL of type `image/svg+xml` opened in its own tab is a document in the
 * review origin, and whether script runs there depends on the browser. AVIF is refused because
 * its decoded size cannot be bounded cheaply from the container.
 *
 * Before any `Blob` exists, `headerImageSize` reads the dimensions every accepted format states
 * in its header, with bounds-checked reads that return nothing on truncated or malformed bytes.
 * An image whose size cannot be read is not previewed, and one past `PREVIEW_IMAGE_LIMITS` is
 * refused, because a few-KB file can declare a size that decodes to gigabytes.
 */

/** Image types a preview may be built from: raster formats only. */
export type PreviewImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp"
  | "image/x-icon";

/** Every type a preview `Blob` may carry; checked again right before a blob is created. */
export const PREVIEW_IMAGE_MIMES: ReadonlySet<string> = new Set<PreviewImageMime>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
]);

/** The largest image a preview decodes: per side, and in total pixels. */
export const PREVIEW_IMAGE_LIMITS = { side: 16_384, pixels: 50_000_000 } as const;

const IMAGE_EXTENSIONS = new Set(["png", "apng", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

/** Whether a path names an image format the page can preview. */
export function isPreviewImagePath(path: string) {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Whether `bytes` starts with `signature` at `offset`. */
function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  if (offset < 0 || bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

const ASCII = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image type the first bytes declare, or nothing when they declare none. */
export function sniffPreviewImageMime(bytes: Uint8Array): PreviewImageMime | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ASCII("GIF87a")) || startsWith(bytes, ASCII("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ASCII("RIFF")) && startsWith(bytes, ASCII("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ASCII("BM")) && bytes.length >= 26) return "image/bmp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  return undefined;
}

/** Bounds-checked integer reads that return `undefined` instead of throwing. */
function reader(bytes: Uint8Array) {
  const has = (offset: number, length: number) =>
    Number.isInteger(offset) && offset >= 0 && offset + length <= bytes.length;
  return {
    u8: (offset: number) => (has(offset, 1) ? bytes[offset]! : undefined),
    u16be: (offset: number) =>
      has(offset, 2) ? (bytes[offset]! << 8) | bytes[offset + 1]! : undefined,
    u16le: (offset: number) =>
      has(offset, 2) ? bytes[offset]! | (bytes[offset + 1]! << 8) : undefined,
    u24le: (offset: number) =>
      has(offset, 3)
        ? bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
        : undefined,
    u32be: (offset: number) =>
      has(offset, 4)
        ? ((bytes[offset]! << 24) >>> 0) +
          ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
        : undefined,
    u32le: (offset: number) =>
      has(offset, 4)
        ? ((bytes[offset + 3]! << 24) >>> 0) +
          ((bytes[offset + 2]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset]!)
        : undefined,
    i32le: (offset: number) =>
      has(offset, 4)
        ? bytes[offset]! |
          (bytes[offset + 1]! << 8) |
          (bytes[offset + 2]! << 16) |
          (bytes[offset + 3]! << 24)
        : undefined,
  };
}

/** One image's declared dimensions in pixels. */
export interface ImageSize {
  width: number;
  height: number;
}

/** A size from two reads, when both succeeded. */
function size(width: number | undefined, height: number | undefined): ImageSize | undefined {
  return width === undefined || height === undefined ? undefined : { width, height };
}

/** PNG: the `IHDR` chunk, which the format requires first. */
function pngSize(bytes: Uint8Array, offset = 0) {
  if (!startsWith(bytes, PNG_SIGNATURE, offset) || !startsWith(bytes, ASCII("IHDR"), offset + 12)) {
    return undefined;
  }
  const read = reader(bytes);
  return size(read.u32be(offset + 16), read.u32be(offset + 20));
}

/** GIF: the logical screen size, which every frame is drawn within. */
function gifSize(bytes: Uint8Array) {
  const read = reader(bytes);
  return size(read.u16le(6), read.u16le(8));
}

/**
 * JPEG: the first start-of-frame segment. Walks marker segments by their lengths, so each
 * step moves forward at least two bytes; reaching start-of-scan or the end first means the
 * size is unknown.
 */
function jpegSize(bytes: Uint8Array) {
  const read = reader(bytes);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    // Any number of 0xFF fill bytes may precede a marker.
    while (bytes[offset] === 0xff) offset += 1;
    const marker = read.u8(offset);
    if (marker === undefined) return undefined;
    offset += 1;
    // Standalone markers carry no length: TEM and RST0–RST7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return undefined;
    const length = read.u16be(offset);
    if (length === undefined || length < 2) return undefined;
    // SOF0–SOF15, except DHT (C4), JPG (C8), and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const found = size(read.u16be(offset + 5), read.u16be(offset + 3));
      // A zero height defers to a later DNL segment, which this reader does not follow.
      return found && found.width > 0 && found.height > 0 ? found : undefined;
    }
    offset += length;
  }
  return undefined;
}

/** WebP: the first chunk's frame header (`VP8 `, `VP8L`) or extended canvas (`VP8X`). */
function webpSize(bytes: Uint8Array) {
  const read = reader(bytes);
  if (startsWith(bytes, ASCII("VP8 "), 12)) {
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined;
    const width = read.u16le(26);
    const height = read.u16le(28);
    return size(
      width === undefined ? undefined : width & 0x3fff,
      height === undefined ? undefined : height & 0x3fff,
    );
  }
  if (startsWith(bytes, ASCII("VP8L"), 12)) {
    const bits = read.u32le(21);
    if (read.u8(20) !== 0x2f || bits === undefined) return undefined;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (startsWith(bytes, ASCII("VP8X"), 12)) {
    const width = read.u24le(24);
    const height = read.u24le(27);
    return size(
      width === undefined ? undefined : width + 1,
      height === undefined ? undefined : height + 1,
    );
  }
  return undefined;
}

/** A BMP DIB header at `offset`: core (12-byte) or info (40-byte and later) form. */
function dibSize(bytes: Uint8Array, offset: number) {
  const read = reader(bytes);
  const headerSize = read.u32le(offset);
  if (headerSize === 12) return size(read.u16le(offset + 4), read.u16le(offset + 6));
  if (headerSize === undefined || headerSize < 40) return undefined;
  const width = read.i32le(offset + 4);
  const height = read.i32le(offset + 8);
  // A negative height means top-down rows; the magnitude is the size.
  return size(
    width === undefined ? undefined : Math.abs(width),
    height === undefined ? undefined : Math.abs(height),
  );
}

/**
 * ICO: the largest size across directory entries and the images they point to. An entry's
 * directory bytes can lie, so an embedded PNG's `IHDR` or BMP's DIB header counts too, and an
 * entry whose image cannot be read makes the whole file unreadable.
 */
function icoSize(bytes: Uint8Array) {
  const read = reader(bytes);
  const count = read.u16le(4);
  if (count === undefined || count === 0) return undefined;
  let width = 0;
  let height = 0;
  for (let entry = 0; entry < count; entry += 1) {
    const base = 6 + entry * 16;
    const declaredWidth = read.u8(base);
    const declaredHeight = read.u8(base + 1);
    const imageOffset = read.u32le(base + 12);
    if (declaredWidth === undefined || declaredHeight === undefined || imageOffset === undefined) {
      return undefined;
    }
    const embedded = startsWith(bytes, PNG_SIGNATURE, imageOffset)
      ? pngSize(bytes, imageOffset)
      : dibSize(bytes, imageOffset);
    if (!embedded) return undefined;
    width = Math.max(width, declaredWidth || 256, embedded.width);
    height = Math.max(height, declaredHeight || 256, embedded.height);
  }
  return { width, height };
}

/** The dimensions an accepted image's header states, or nothing when they cannot be read. */
export function headerImageSize(bytes: Uint8Array, mime: PreviewImageMime): ImageSize | undefined {
  switch (mime) {
    case "image/png":
      return pngSize(bytes);
    case "image/gif":
      return gifSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    case "image/bmp":
      return dibSize(bytes, 14);
    case "image/x-icon":
      return icoSize(bytes);
  }
}

/** Why an image of this size is not decoded, or nothing when it is small enough. */
export function previewImageRefusal({ width, height }: ImageSize) {
  if (width <= 0 || height <= 0) return "Image has no size to preview";
  if (
    width > PREVIEW_IMAGE_LIMITS.side ||
    height > PREVIEW_IMAGE_LIMITS.side ||
    width * height > PREVIEW_IMAGE_LIMITS.pixels
  ) {
    return `Image too large to preview: ${width} × ${height}`;
  }
  return undefined;
}

/** The largest box a preview image is drawn in, in CSS pixels. */
export const PREVIEW_IMAGE_MAX = { width: 460, height: 320 } as const;

/**
 * The size one image is drawn at: shrunk to fit the preview box, or enlarged by a whole factor
 * (at most 8×, drawn pixelated) so a small icon is still inspectable, never blurred.
 */
export function previewDisplaySize(width: number, height: number) {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const fit = Math.min(PREVIEW_IMAGE_MAX.width / width, PREVIEW_IMAGE_MAX.height / height);
  const scale = fit >= 1 ? Math.max(1, Math.min(8, Math.floor(fit))) : fit;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
