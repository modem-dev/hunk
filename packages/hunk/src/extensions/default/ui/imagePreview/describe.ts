/**
 * Formats image facts for the image preview's captions: dimensions, format, byte size, and what
 * changed between sides. Bytes that cannot be decoded surface as a reason instead of throwing, so
 * one corrupt or pointer-only image cannot take the file view down.
 */

import { imageInfo } from "@opentui/core";

export interface ImageFacts {
  width: number;
  height: number;
  format: string;
  bytes: number;
}

const LFS_POINTER_PREFIX = "version https://git-lfs";

/** Read dimensions and format from image bytes, or return a reason they cannot be shown. */
export function readImageFacts(bytes: Uint8Array): ImageFacts | { error: string } {
  // A Git LFS checkout without the object stores a small text pointer under the image's name.
  if (new TextDecoder().decode(bytes.subarray(0, 64)).startsWith(LFS_POINTER_PREFIX)) {
    return { error: "stored in Git LFS; only the pointer file is in the repository" };
  }

  try {
    const info = imageInfo(bytes);
    return {
      width: info.sourceWidth,
      height: info.sourceHeight,
      format: info.format.toUpperCase(),
      bytes: bytes.length,
    };
  } catch {
    return { error: "not a decodable PNG, JPEG, GIF, or WebP image" };
  }
}

/** Format a byte count the way file managers do: B, KB, MB with one decimal below 10 KB. */
export function formatImageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Describe one side for its caption, e.g. `640×480 PNG · 41 KB`. */
export function describeImageSide(facts: ImageFacts) {
  return `${facts.width}×${facts.height} ${facts.format} · ${formatImageBytes(facts.bytes)}`;
}

/** Summarize what changed between two sides, e.g. `512×512 → 640×480 · 34 KB → 41 KB (+7.0 KB)`. */
export function describeImageChange(before: ImageFacts, after: ImageFacts) {
  const parts: string[] = [];
  if (before.width !== after.width || before.height !== after.height) {
    parts.push(`${before.width}×${before.height} → ${after.width}×${after.height}`);
  } else {
    parts.push(`same size ${after.width}×${after.height}`);
  }
  if (before.format !== after.format) parts.push(`${before.format} → ${after.format}`);

  const delta = after.bytes - before.bytes;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  parts.push(
    `${formatImageBytes(before.bytes)} → ${formatImageBytes(after.bytes)} (${sign}${formatImageBytes(Math.abs(delta))})`,
  );
  return parts.join(" · ");
}
