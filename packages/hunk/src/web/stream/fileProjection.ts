/**
 * Projects one mirrored review file into what the page hands Pierre and draws around it.
 *
 * This is the browser's one projection from `ReviewFileV1` to rendering, registered against
 * the review conformance corpus. Every geometric fact comes from `core/review`: gap
 * addresses from `expansion.ts`, the reason a file renders nothing from `document.ts`,
 * expanded gaps folded into hunks by `reviewFileWithExpandedGaps`, and expansion state and
 * source status from the page's local store. What stays here is translation — the shared
 * model is already Pierre-shaped, so a file becomes Pierre metadata field for field — and the
 * row counts the stream reserves before a file mounts.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import { reviewEmptyDiffReason, type ReviewEmptyDiffReason } from "../../core/review/document";
import {
  reviewExpandedGapContents,
  reviewFileWithExpandedGaps,
  reviewGapId,
  reviewGapSourceForFile,
  reviewLeadingGap,
  reviewTrailingGap,
  type ReviewGapAddress,
} from "../../core/review/expansion";
import { isReviewGapExpanded } from "../../core/review/selectors";
import type { ReviewState } from "../../core/review/state";
import type { ReviewFileV1 } from "../../core/review/types";

/** What one gap shows: folded away, filled in, or why it cannot be filled yet. */
export type ReviewGapViewState = "collapsed" | "expanded" | "loading" | "error" | "too-large";

export interface ReviewGapView {
  gapId: string;
  address: ReviewGapAddress;
  state: ReviewGapViewState;
}

/** Everything the stream needs to draw one file. */
export interface ReviewFileRenderPlan {
  file: ReviewFileV1;
  /** Set for a file with no hunks; the page draws a placeholder instead of Pierre. */
  emptyReason?: ReviewEmptyDiffReason;
  /** What Pierre renders, with expanded gaps folded in. */
  metadata?: FileDiffMetadata;
  /** Every gap the file offers, in render order, with its current state. */
  gaps: ReviewGapView[];
  /** Rows Pierre will draw in each layout, reserved before the file mounts. */
  reservedRows: { split: number; unified: number };
}

/** Every gap one file offers, in render order: before each hunk, then trailing. */
export function reviewFileGaps(file: ReviewFileV1): ReviewGapAddress[] {
  const source = reviewGapSourceForFile(file);
  const gaps = file.hunks.flatMap((_hunk, index) => {
    const gap = reviewLeadingGap(source, index);
    return gap ? [gap] : [];
  });
  const trailing = reviewTrailingGap(source);
  return trailing ? [...gaps, trailing] : gaps;
}

/**
 * The core gap id for the separator Pierre draws at one hunk index.
 *
 * Pierre numbers the separator before hunk `h` with `h`, and the one after the last hunk
 * with the hunk count; core names them `before:h` and `trailing:<last>`.
 */
export function reviewGapIdForSeparator(file: ReviewFileV1, separatorHunkIndex: number) {
  return separatorHunkIndex >= file.hunks.length
    ? reviewGapId("trailing", file.hunks.length - 1)
    : reviewGapId("before", separatorHunkIndex);
}

/**
 * Translate one shared-model file into Pierre's parsed-diff metadata.
 *
 * `cacheKey` must change whenever the rendered content does: Pierre treats two metadata
 * objects with one key as the same diff and skips the re-render.
 */
export function toPierreFileDiff(
  file: ReviewFileV1,
  cacheKey = file.contentIdentity,
): FileDiffMetadata {
  return {
    name: file.path,
    ...(file.previousPath !== undefined ? { prevName: file.previousPath } : {}),
    ...(file.language !== undefined ? { lang: file.language } : {}),
    type: file.changeKind,
    hunks: file.hunks.map((hunk) => ({
      collapsedBefore: hunk.collapsedBefore,
      additionStart: hunk.additionStart,
      additionCount: hunk.additionCount,
      additionLines: hunk.additionLines,
      additionLineIndex: hunk.additionLineIndex,
      deletionStart: hunk.deletionStart,
      deletionCount: hunk.deletionCount,
      deletionLines: hunk.deletionLines,
      deletionLineIndex: hunk.deletionLineIndex,
      hunkContent: hunk.hunkContent.map((block) => ({ ...block })),
      ...(hunk.hunkContext !== undefined ? { hunkContext: hunk.hunkContext } : {}),
      ...(hunk.hunkSpecs !== undefined ? { hunkSpecs: hunk.hunkSpecs } : {}),
      splitLineStart: hunk.splitLineStart,
      splitLineCount: hunk.splitLineCount,
      unifiedLineStart: hunk.unifiedLineStart,
      unifiedLineCount: hunk.unifiedLineCount,
      noEOFCRAdditions: hunk.noEOFCRAdditions,
      noEOFCRDeletions: hunk.noEOFCRDeletions,
    })),
    splitLineCount: file.splitLineCount,
    unifiedLineCount: file.unifiedLineCount,
    isPartial: file.flags.partial,
    additionLines: file.additionLines,
    deletionLines: file.deletionLines,
    cacheKey,
  };
}

/**
 * One planned file's rows as the stream draws them, in both layouts.
 *
 * The shared model counts every gap's lines in a file's rows; the stream draws a gap that is
 * not expanded as one separator row. Each hunk's start moves up by what the collapsed gaps
 * at or before it fold away, and the totals are the plan's reserved rows, so an overview that
 * places hunks by these fractions lands where they are drawn, and follows a gap's expansion.
 */
export function reviewDrawnRows(plan: ReviewFileRenderPlan) {
  const folded = (hunkIndex: number) =>
    plan.gaps
      .filter(
        (gap) =>
          gap.state !== "expanded" &&
          gap.address.position === "before" &&
          gap.address.hunkIndex <= hunkIndex,
      )
      .reduce((rows, gap) => rows + gap.address.lineCount - 1, 0);
  return {
    splitLineCount: plan.reservedRows.split,
    unifiedLineCount: plan.reservedRows.unified,
    hunks: plan.file.hunks.map((hunk, index) => ({
      splitLineStart: hunk.splitLineStart - folded(index),
      splitLineCount: hunk.splitLineCount,
      unifiedLineStart: hunk.unifiedLineStart - folded(index),
      unifiedLineCount: hunk.unifiedLineCount,
    })),
  };
}

/** Plan one file's rendering against the page's local review state. */
export function planReviewFileRender(
  file: ReviewFileV1,
  state: Pick<ReviewState, "expandedGaps" | "sourceStatusByFileKey">,
): ReviewFileRenderPlan {
  if (file.hunks.length === 0) {
    return {
      file,
      emptyReason: reviewEmptyDiffReason({
        changeKind: file.changeKind,
        binary: file.flags.binary,
        tooLarge: file.flags.tooLarge,
      }),
      gaps: [],
      reservedRows: { split: 1, unified: 1 },
    };
  }

  const status = state.sourceStatusByFileKey[file.key];
  const expandedIds: string[] = [];
  const gaps = reviewFileGaps(file).map((address): ReviewGapView => {
    const gapId = reviewGapId(address.position, address.hunkIndex);
    if (!isReviewGapExpanded(state, file.key, gapId)) {
      return { gapId, address, state: "collapsed" };
    }
    if (status?.kind === "loaded") {
      expandedIds.push(gapId);
      return { gapId, address, state: "expanded" };
    }
    if (status?.kind === "error") {
      return { gapId, address, state: status.reason === "too-large" ? "too-large" : "error" };
    }
    return { gapId, address, state: "loading" };
  });

  const contents =
    status?.kind === "loaded" ? reviewExpandedGapContents(file, expandedIds, status.text) : [];
  const filled = new Set(
    contents.map((content) => reviewGapId(content.address.position, content.address.hunkIndex)),
  );
  const settledGaps = gaps.map((gap) =>
    gap.state === "expanded" && !filled.has(gap.gapId) ? { ...gap, state: "error" as const } : gap,
  );
  const rendered = reviewFileWithExpandedGaps(file, contents);

  // A collapsed gap draws one separator row in place of its lines, which the file's totals
  // count in full.
  const folded = settledGaps
    .filter((gap) => gap.state !== "expanded")
    .reduce((rows, gap) => rows + gap.address.lineCount - 1, 0);
  return {
    file,
    metadata: toPierreFileDiff(rendered, [file.contentIdentity, ...filled].join("+")),
    gaps: settledGaps,
    reservedRows: {
      split: Math.max(1, file.splitLineCount - folded),
      unified: Math.max(1, file.unifiedLineCount - folded),
    },
  };
}
