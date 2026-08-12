/**
 * Semantic addresses: one grammar for pointing at a place in a review.
 *
 * Three consumers need to name a location across a boundary — a browser deep link and its
 * history entries, a terminal "copy link" command, and agent surfaces that already address
 * targets by file and hunk (`docs/browser-review-seam-audit.md`, G3). Without one grammar
 * each would invent its own string format and they would stop understanding each other.
 *
 * Addresses are built from semantic keys only: a file key, a hunk index, a side and line,
 * a note id. Never an index into rendered rows — those depend on layout, expansion state,
 * and window width, so an address built from them means something different in the next
 * client, or in the same client one keypress later.
 *
 * The serialized form is a slash-separated path with percent-encoded identifier segments,
 * which makes it safe inside a URL fragment without further escaping.
 */
import type { ReviewSide } from "./types";

export type ReviewAddress =
  | { kind: "file"; fileKey: string }
  | { kind: "hunk"; fileKey: string; hunkIndex: number }
  | { kind: "line"; fileKey: string; side: ReviewSide; line: number }
  | { kind: "note"; fileKey: string; noteId: string };

/** Serialize one address into its canonical string form. */
export function formatReviewAddress(address: ReviewAddress): string {
  const file = `file/${encodeURIComponent(address.fileKey)}`;
  switch (address.kind) {
    case "file":
      return file;
    case "hunk":
      return `${file}/hunk/${address.hunkIndex}`;
    case "line":
      return `${file}/line/${address.side}/${address.line}`;
    case "note":
      return `${file}/note/${encodeURIComponent(address.noteId)}`;
  }
}

/** Decode one identifier segment, rejecting an empty or malformed one. */
function decodeSegment(segment: string | undefined) {
  if (!segment) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    // A stray percent sign is a malformed address, not a key containing one.
    return undefined;
  }
}

/** Parse one non-negative integer segment, rejecting anything else. */
function parseIndex(segment: string | undefined, minimum: number) {
  if (segment === undefined || !/^\d+$/.test(segment)) {
    return undefined;
  }
  const value = Number(segment);
  return Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

/**
 * Parse one address, or report that the text is not one.
 *
 * Deliberately strict: an address that arrived from a link, a fragment, or an agent
 * command is untrusted input, and a half-understood one would silently navigate somewhere
 * other than where it points. Anything that is not exactly this grammar is rejected.
 */
export function parseReviewAddress(text: string): ReviewAddress | undefined {
  const segments = text.split("/");
  if (segments[0] !== "file") {
    return undefined;
  }

  const fileKey = decodeSegment(segments[1]);
  if (fileKey === undefined) {
    return undefined;
  }

  if (segments.length === 2) {
    return { kind: "file", fileKey };
  }

  switch (segments[2]) {
    case "hunk": {
      const hunkIndex = segments.length === 4 ? parseIndex(segments[3], 0) : undefined;
      return hunkIndex === undefined ? undefined : { kind: "hunk", fileKey, hunkIndex };
    }
    case "line": {
      const side = segments[3];
      // Lines are 1-based everywhere in the model, so line 0 is not an address.
      const line = segments.length === 5 ? parseIndex(segments[4], 1) : undefined;
      return line === undefined || (side !== "old" && side !== "new")
        ? undefined
        : { kind: "line", fileKey, side, line };
    }
    case "note": {
      const noteId = segments.length === 4 ? decodeSegment(segments[3]) : undefined;
      return noteId === undefined ? undefined : { kind: "note", fileKey, noteId };
    }
    default:
      return undefined;
  }
}
