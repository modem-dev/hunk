/**
 * Diff geometry: the questions every review renderer asks about a hunk.
 *
 * Which lines does a hunk occupy, which line does a whole-hunk note hang from, how do a
 * hunk's line indices move when its content is re-based onto another array, and how is
 * full source text split into the lines an expanded gap fills. Each answer lives here
 * once, because a renderer that re-derives one silently disagrees with the state store
 * that validates against it (`docs/browser-review-seam-audit.md`, A3/A4/A6/A10).
 *
 * The inputs are structural rather than `ReviewFileV1`: a parsed diff hunk and a projected
 * `ReviewHunkV1` both satisfy them, so the terminal can call these primitives from its
 * render path without projecting a whole semantic document first.
 */
import type { ReviewLineAddressV1, ReviewLineRange, ReviewSide } from "./types";

/** The per-side extent of one hunk: 1-based start plus the rows it spans on that side. */
export interface ReviewHunkSpan {
  additionStart: number;
  additionCount: number;
  deletionStart: number;
  deletionCount: number;
}

export interface ReviewHunkContentBlock {
  type: "context" | "change";
  lines?: number;
  additions?: number;
  deletions?: number;
}

export interface ReviewHunkContent {
  hunkContent: readonly ReviewHunkContentBlock[];
}

/**
 * The inclusive line range one hunk occupies on one side.
 *
 * `*Count` covers context and changed rows alike — the header's `-X,count` / `+X,count` —
 * so a note anchored to a hunk's leading context still falls inside its own hunk. A side
 * with no rows still reports one line: a pure insertion has an old-side position even
 * though it deletes nothing, and callers testing containment need a non-empty range.
 *
 * The tuple is freshly built on every call, which is why it is handed back mutable while
 * the ranges stored on an anchor stay `ReviewLineRange`.
 */
export function reviewHunkRange(hunk: ReviewHunkSpan, side: ReviewSide): [number, number] {
  const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
  const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
  return [start, start + Math.max(count, 1) - 1];
}

/** Both of one hunk's per-side extents, for callers that carry the pair together. */
export function reviewHunkRanges(hunk: ReviewHunkSpan) {
  return { oldRange: reviewHunkRange(hunk, "old"), newRange: reviewHunkRange(hunk, "new") };
}

/** Return whether two inclusive line ranges overlap. */
export function reviewRangesOverlap(left: ReviewLineRange, right: ReviewLineRange) {
  return left[0] <= right[1] && right[0] <= left[1];
}

/** Find the first hunk whose extent on one side covers one line, or -1. */
export function reviewHunkIndexForLine(
  hunks: readonly ReviewHunkSpan[],
  side: ReviewSide,
  line: number,
) {
  return hunks.findIndex((hunk) => {
    const [start, end] = reviewHunkRange(hunk, side);
    return line >= start && line <= end;
  });
}

/**
 * The line a note addressed to a whole hunk hangs from.
 *
 * Policy: the hunk's first added line, else its first deleted line, else the first line
 * of its new-side extent. Anchoring to the hunk's first line instead would usually land
 * on leading context — technically inside the hunk, but not on the change the note is
 * about.
 */
export function reviewDefaultHunkLineTarget(
  hunk: ReviewHunkSpan & ReviewHunkContent,
): ReviewLineAddressV1 {
  let deletionLine = hunk.deletionStart;
  let additionLine = hunk.additionStart;
  let firstDeletionLine: number | undefined;

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      deletionLine += content.lines ?? 0;
      additionLine += content.lines ?? 0;
      continue;
    }
    if ((content.additions ?? 0) > 0) {
      return { side: "new", line: additionLine };
    }
    if ((content.deletions ?? 0) > 0 && firstDeletionLine === undefined) {
      firstDeletionLine = deletionLine;
    }
    deletionLine += content.deletions ?? 0;
    additionLine += content.additions ?? 0;
  }

  return firstDeletionLine !== undefined
    ? { side: "old", line: firstDeletionLine }
    : { side: "new", line: reviewHunkRange(hunk, "new")[0] };
}

/**
 * The line one hunk is canonically addressed by, on a side that really has rows.
 *
 * Every hunk reports a range on both sides — a pure insertion still has an old-side
 * position — so choosing a side by "does it have a range" always answers "new" and
 * scrolls a pure-deletion hunk to a line the file does not contain
 * (`docs/browser-review-seam-audit.md`, B6). The choice is made by row counts instead:
 * the preferred side when it is backed, otherwise the other, and undefined when a hunk
 * has rows on neither.
 *
 * This is the hunk's *position*, which is what a reveal scrolls to. Where a note about
 * the whole hunk hangs is a different question, answered by `reviewDefaultHunkLineTarget`.
 */
export function reviewCanonicalHunkLine(
  hunk: ReviewHunkSpan,
  preferredSide: ReviewSide = "new",
): ReviewLineAddressV1 | undefined {
  for (const side of [preferredSide, preferredSide === "new" ? "old" : "new"] as const) {
    const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
    if (count > 0) {
      return { side, line: side === "new" ? hunk.additionStart : hunk.deletionStart };
    }
  }
  return undefined;
}

/** Zero-based array origins one hunk's content is re-based onto. */
export interface ReviewHunkOrigins {
  deletionLineIndex: number;
  additionLineIndex: number;
}

export interface RebasedReviewHunk<T> {
  hunk: T;
  /** One past the last index each side consumed; slicing and validation both need it. */
  deletionEndIndex: number;
  additionEndIndex: number;
}

interface RebasableHunk extends ReviewHunkOrigins {
  hunkContent: readonly ReviewHunkContentBlock[];
}

/**
 * Re-base one hunk's line indices onto new array origins.
 *
 * Rendering a hunk in isolation slices its lines to origin zero; highlighting a partial
 * patch against full source text re-bases the same indices onto whole-file positions.
 * Both are the same walk, and the prototype implemented them twice with opposite
 * conclusions about the result (A6).
 *
 * The walk lays content out contiguously from the origins rather than shifting each
 * block by a delta, which is what makes the returned end indices meaningful: a caller
 * compares them against the hunk's declared counts to detect a patch whose blocks do not
 * add up.
 */
export function rebaseReviewHunk<T extends RebasableHunk>(
  hunk: T,
  origins: ReviewHunkOrigins,
): RebasedReviewHunk<T> {
  let deletionLineIndex = origins.deletionLineIndex;
  let additionLineIndex = origins.additionLineIndex;
  const hunkContent = hunk.hunkContent.map((content) => {
    const rebased = { ...content, deletionLineIndex, additionLineIndex };
    if (content.type === "context") {
      deletionLineIndex += content.lines ?? 0;
      additionLineIndex += content.lines ?? 0;
    } else {
      deletionLineIndex += content.deletions ?? 0;
      additionLineIndex += content.additions ?? 0;
    }
    return rebased;
  });

  return {
    hunk: { ...hunk, ...origins, hunkContent } as T,
    deletionEndIndex: deletionLineIndex,
    additionEndIndex: additionLineIndex,
  };
}

/**
 * Split full source text into the lines an expanded gap addresses.
 *
 * CRLF collapses so a Windows-authored file cannot leak `\r` into a rendered row, and a
 * single trailing newline is dropped so the last line of a file is its last line rather
 * than a phantom empty one. Line N of the result is at index N-1, which is the contract
 * every gap range is resolved against.
 *
 * A highlighter that needs the newlines back must keep its own split; this one is for
 * addressing lines, not for reproducing bytes.
 */
export function normalizedReviewSourceLines(sourceText: string): string[] {
  const normalized = sourceText.replaceAll("\r\n", "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.length === 0 ? [] : trimmed.split("\n");
}
