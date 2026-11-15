/**
 * Decides whether a binary file is an image the page may preview, and with what MIME type.
 *
 * Two checks, both required: the path names an image format (so a renamed blob is not shown
 * as a picture by accident), and the first bytes carry that family's signature (so the path
 * is never trusted alone). The MIME type always comes from the signature, never from the path,
 * and is the only type a preview `Blob` is ever given.
 */

/** Image types a preview may be built from. */
export type PreviewImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp"
  | "image/x-icon"
  | "image/avif"
  | "image/svg+xml";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "apng",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
]);

/** Whether a path names an image format the page can preview. */
export function isPreviewImagePath(path: string) {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Whether `bytes` starts with `signature` at `offset`. */
function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

const ASCII = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

/** An SVG document, possibly after an XML declaration, comments, and a doctype. */
const SVG_START =
  /^﻿?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype\s+svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/** The image type the first bytes declare, or nothing when they declare none. */
export function sniffPreviewImageMime(bytes: Uint8Array): PreviewImageMime | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ASCII("GIF87a")) || startsWith(bytes, ASCII("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ASCII("RIFF")) && startsWith(bytes, ASCII("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ASCII("BM")) && bytes.length >= 26) return "image/bmp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (
    startsWith(bytes, ASCII("ftyp"), 4) &&
    (startsWith(bytes, ASCII("avif"), 8) || startsWith(bytes, ASCII("avis"), 8))
  ) {
    return "image/avif";
  }
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024));
  return SVG_START.test(head) ? "image/svg+xml" : undefined;
}

/** The PNG, GIF, or BMP dimensions the header states, when it states them; others are read on load. */
export function headerImageSize(bytes: Uint8Array, mime: PreviewImageMime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === "image/gif" && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
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
