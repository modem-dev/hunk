/**
 * Turning one semantic file into what a browser draws it from.
 *
 * Pierre renders a diff from its own `FileDiffMetadata`, and the review model carries every
 * fact that shape needs — a review hunk *is* a Pierre hunk plus an index, and the row totals
 * a renderer sizes with are carried on the file rather than reduced from its hunks. So this
 * adapter mostly renames, and its value is in what it refuses to compute: gap ranges, hunk
 * extents, note targets, reveal targets, expansion side, and source splitting all come from
 * `src/core/review/`, because a renderer that derives one of them disagrees with the state
 * store that validates against it.
 *
 * Each of those is an audit finding with a browser site
 * (`docs/browser-review-seam-audit.md`): the prototype's own adapter measured hunk extents
 * from changed-line counts (A3), guessed the file's row totals (A7), re-derived the
 * expansion side (A5), split source text with a bare `split("\n")` (A4), and rebased an
 * isolated hunk's indices with a second walk that disagreed with the terminal's about
 * whether the result was partial (A6). None of that happens here.
 *
 * The module is renderer-shaped but DOM-free: it produces values, not elements, so every
 * geometry question the conformance corpus asks can be answered without a browser.
 */
import type { FileDiffMetadata, Hunk, SupportedLanguages } from "@pierre/diffs";
import { reviewEmptyDiffReason, type ReviewEmptyDiffReason } from "../core/review/document";
import {
  reviewExpandedGapLines,
  reviewExpansionSide,
  reviewGapAddress,
  reviewGapId,
  reviewGapSourceForFile,
  reviewLeadingGap,
  reviewTrailingGap,
  type ReviewGapAddress,
} from "../core/review/expansion";
import {
  normalizedReviewSourceLines,
  rebaseReviewHunk,
  reviewCanonicalHunkLine,
  reviewDefaultHunkLineTarget,
  reviewHunkRanges,
} from "../core/review/geometry";
import { reviewFileStatBadges, type ReviewFileStatBadges } from "../core/review/presentation";
import type {
  ReviewFileV1,
  ReviewHunkV1,
  ReviewLineAddressV1,
  ReviewLineRange,
  ReviewSide,
} from "../core/review/types";

/** One hunk, as the stream needs to place it and address it. */
export interface BrowserReviewRenderHunk {
  index: number;
  /** Inclusive per-side extents, so a note or a highlight lands inside its own hunk. */
  oldRange: ReviewLineRange;
  newRange: ReviewLineRange;
  /** Where a note about this whole hunk hangs (A10). */
  noteTarget: ReviewLineAddressV1;
  /**
   * The line this hunk is scrolled to, on a side that really has rows (B6).
   *
   * Absent for a hunk with rows on neither side, which is not something to scroll to.
   */
  revealTarget?: ReviewLineAddressV1;
  /** Pierre's description of this hunk alone, for rendering it between two gap strips. */
  fileDiff: FileDiffMetadata;
}

/** One collapsed region, addressed the way every consumer addresses it. */
export interface BrowserReviewRenderGap extends ReviewGapAddress {
  gapId: string;
}

/** Everything the stream needs to draw one file, and nothing it has to derive itself. */
export interface BrowserReviewFileRenderModel {
  fileKey: string;
  path: string;
  previousPath?: string;
  language?: string;
  statBadges: ReviewFileStatBadges;
  /** Row totals the parser measured, carried rather than reduced from hunks (A7). */
  splitLineCount: number;
  unifiedLineCount: number;
  /** The side whose full source text fills this file's gaps (A5). */
  expansionSide: ReviewSide;
  /** Identity of that source, so an expansion knows which text it read. */
  sourceIdentity?: string;
  gaps: BrowserReviewRenderGap[];
  hunks: BrowserReviewRenderHunk[];
  /** Why there is nothing to draw, for a file with no rows (A8). */
  emptyDiffReason?: ReviewEmptyDiffReason;
}

/** One row an expanded gap reveals: the labels on each side, and the text between them. */
export interface BrowserReviewExpandedRow {
  oldLine: number;
  newLine: number;
  text: string;
}

/** The Pierre change type one review change kind is; the two vocabularies are the same. */
function pierreChangeType(file: ReviewFileV1): FileDiffMetadata["type"] {
  return file.changeKind;
}

/** The parts of Pierre's file metadata that describe the file rather than its rows. */
function pierreFileHeader(file: ReviewFileV1) {
  return {
    name: file.path,
    ...(file.previousPath !== undefined ? { prevName: file.previousPath } : {}),
    ...(file.language !== undefined ? { lang: file.language as SupportedLanguages } : {}),
    type: pierreChangeType(file),
    // Always partial: a review file carries the patch's lines, not the whole file's, and
    // telling Pierre otherwise would offer expansion it has no content for. Expansion is
    // the review's own, through the gap addresses below.
    isPartial: true,
  };
}

/** One review hunk as Pierre's, which is the same record without the review's index. */
function pierreHunk(hunk: ReviewHunkV1): Hunk {
  const { index: _index, ...rest } = hunk;
  return rest as unknown as Hunk;
}

/**
 * Pierre metadata for one hunk on its own.
 *
 * Rendering hunk by hunk is what lets the stream put a collapsed-region strip where the
 * collapsed region actually is, rather than around the whole file. The hunk's line indices
 * are re-based onto a zero origin by the shared walk, which also reports where each side
 * ends — so the lines are sliced with the same numbers the re-basing used, instead of by a
 * second count that could disagree with it (A6).
 */
export function isolateBrowserReviewHunk(file: ReviewFileV1, hunk: ReviewHunkV1): FileDiffMetadata {
  const rebased = rebaseReviewHunk(hunk, { additionLineIndex: 0, deletionLineIndex: 0 });
  return {
    ...pierreFileHeader(file),
    hunks: [
      pierreHunk({
        ...rebased.hunk,
        // Drawn on its own, so it starts at the top of its own render and reports no
        // collapsed region: the strip beside it is what says lines were omitted.
        collapsedBefore: 0,
        splitLineStart: 0,
        unifiedLineStart: 0,
      }),
    ],
    additionLines: file.additionLines.slice(
      hunk.additionLineIndex,
      hunk.additionLineIndex + rebased.additionEndIndex,
    ),
    deletionLines: file.deletionLines.slice(
      hunk.deletionLineIndex,
      hunk.deletionLineIndex + rebased.deletionEndIndex,
    ),
    splitLineCount: hunk.splitLineCount,
    unifiedLineCount: hunk.unifiedLineCount,
    // Identity of the content, so Pierre's highlight cache keys on what changed rather
    // than on object identity.
    cacheKey: `${file.contentIdentity}:${hunk.index}`,
  };
}

/** Every collapsed region in one file, in the order a top-to-bottom reader meets them. */
export function browserReviewRenderGaps(file: ReviewFileV1): BrowserReviewRenderGap[] {
  const source = reviewGapSourceForFile(file);
  const leading = file.hunks.flatMap((_hunk, index) => {
    const gap = reviewLeadingGap(source, index);
    return gap ? [{ ...gap, gapId: reviewGapId("before", index) }] : [];
  });
  const trailing = reviewTrailingGap(source);
  return trailing
    ? [...leading, { ...trailing, gapId: reviewGapId("trailing", trailing.hunkIndex) }]
    : leading;
}

/** Build everything the stream draws one file from. */
export function buildBrowserReviewFileRenderModel(
  file: ReviewFileV1,
): BrowserReviewFileRenderModel {
  return {
    fileKey: file.key,
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    ...(file.language !== undefined ? { language: file.language } : {}),
    statBadges: reviewFileStatBadges(file.stats),
    splitLineCount: file.splitLineCount,
    unifiedLineCount: file.unifiedLineCount,
    expansionSide: reviewExpansionSide(file.changeKind),
    ...(file.sourceIdentity !== undefined ? { sourceIdentity: file.sourceIdentity } : {}),
    gaps: browserReviewRenderGaps(file),
    hunks: file.hunks.map((hunk) => {
      const revealTarget = reviewCanonicalHunkLine(hunk);
      return {
        index: hunk.index,
        ...reviewHunkRanges(hunk),
        noteTarget: reviewDefaultHunkLineTarget(hunk),
        ...(revealTarget ? { revealTarget } : {}),
        fileDiff: isolateBrowserReviewHunk(file, hunk),
      };
    }),
    ...(file.hunks.length === 0
      ? {
          emptyDiffReason: reviewEmptyDiffReason({
            changeKind: file.changeKind,
            binary: file.flags.binary,
            tooLarge: file.flags.tooLarge,
          }),
        }
      : {}),
  };
}

/**
 * The rows one expanded gap reveals, given the file's full source text.
 *
 * The gap is resolved by id against the file's current geometry, and the text is split by
 * the shared splitter — CRLF collapsed, one trailing newline dropped — so line N of the
 * source is the line the gap's range calls N. A bare `split("\n")` here is what put `\r`
 * glyphs and a phantom last line into the prototype's browser (A4).
 *
 * Undefined when the gap addresses nothing in this file, which is what a reload that moved
 * the diff looks like from a client still holding the old gap id.
 */
export function browserReviewExpandedGapRows(
  file: ReviewFileV1,
  gapId: string,
  sourceText: string,
): BrowserReviewExpandedRow[] | undefined {
  const address = reviewGapAddress(reviewGapSourceForFile(file), gapId);
  if (!address) {
    return undefined;
  }
  const lines = normalizedReviewSourceLines(sourceText);
  return reviewExpandedGapLines(address, reviewExpansionSide(file.changeKind)).map((line) => ({
    oldLine: line.oldLine,
    newLine: line.newLine,
    text: lines[line.sourceLine - 1] ?? "",
  }));
}
