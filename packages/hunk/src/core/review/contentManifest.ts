/**
 * A deterministic semantic snapshot of one review document.
 *
 * The manifest exists so every consumer of the shared model can be driven through the same
 * fixture and compared against the same snapshot, making a renderer that re-derives
 * geometry instead of consuming core fail visibly rather than drift quietly.
 *
 * It therefore records *derived* geometry — hunk extents, gap addresses, default note
 * targets, the reason a file renders nothing — alongside the content those derivations
 * read. Renderer identity (runtime ids, rows, widths) is left out.
 */
import {
  reviewExpansionSide,
  reviewGapId,
  reviewGapSourceForFile,
  reviewLeadingGap,
  reviewTrailingGap,
  type ReviewGapAddress,
} from "./expansion";
import { reviewDefaultHunkLineTarget, reviewHunkRange } from "./geometry";
import { reviewEmptyDiffReason, type ReviewEmptyDiffReason } from "./document";
import type {
  ReviewDocumentV1,
  ReviewFileFlagsV1,
  ReviewFileStatsV1,
  ReviewFileV1,
  ReviewHunkBlockV1,
  ReviewLineAddressV1,
  ReviewLineRange,
  ReviewSide,
} from "./types";

export interface ReviewContentManifestHunk {
  index: number;
  oldRange: ReviewLineRange;
  newRange: ReviewLineRange;
  /** Where a note addressed to the whole hunk lands. */
  defaultNoteTarget: ReviewLineAddressV1;
  /**
   * The hunk's own content blocks.
   *
   * Recorded so the snapshot covers what a hunk *contains* and not only where it sits —
   * without it, a consumer could serve hunk content that no check ever compares against
   * the model it claims to describe (`docs/browser-review-seam-audit.md`, D4).
   */
  blocks: ReviewHunkBlockV1[];
  leadingGap?: ReviewContentManifestGap;
}

export interface ReviewContentManifestGap {
  gapId: string;
  oldRange: ReviewLineRange;
  newRange: ReviewLineRange;
  lineCount: number;
}

export interface ReviewContentManifestFile {
  key: string;
  path: string;
  previousPath?: string;
  changeKind: string;
  language?: string;
  agentSummary?: string;
  stats: ReviewFileStatsV1;
  flags: ReviewFileFlagsV1;
  contentIdentity: string;
  /**
   * Identity of the expandable source behind the file, when it has one. The content
   * itself is fetched lazily and is not part of a deterministic snapshot; its identity is
   * what says whether two consumers would expand the same text.
   */
  sourceIdentity?: string;
  splitLineCount: number;
  unifiedLineCount: number;
  /** The raw unified diff, so a consumer serving patch bytes is snapshotted too. */
  patch: string;
  additionLines: string[];
  deletionLines: string[];
  expansionSide: ReviewSide;
  emptyDiffReason?: ReviewEmptyDiffReason;
  hunks: ReviewContentManifestHunk[];
  trailingGap?: ReviewContentManifestGap;
}

export interface ReviewContentManifest {
  version: 1;
  files: ReviewContentManifestFile[];
}

/** Record one resolved gap address, keyed by the id every consumer addresses it with. */
function manifestGap(address: ReviewGapAddress): ReviewContentManifestGap {
  return {
    gapId: reviewGapId(address.position, address.hunkIndex),
    oldRange: [...address.oldRange] as ReviewLineRange,
    newRange: [...address.newRange] as ReviewLineRange,
    lineCount: address.lineCount,
  };
}

/** Snapshot one semantic file plus everything a renderer derives from it. */
export function buildReviewContentManifestFile(file: ReviewFileV1): ReviewContentManifestFile {
  const gapSource = reviewGapSourceForFile(file);
  const trailingGap = reviewTrailingGap(gapSource);
  return {
    key: file.key,
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    changeKind: file.changeKind,
    ...(file.language !== undefined ? { language: file.language } : {}),
    ...(file.agentSummary !== undefined ? { agentSummary: file.agentSummary } : {}),
    stats: { ...file.stats },
    flags: { ...file.flags },
    contentIdentity: file.contentIdentity,
    ...(file.sourceIdentity !== undefined ? { sourceIdentity: file.sourceIdentity } : {}),
    splitLineCount: file.splitLineCount,
    unifiedLineCount: file.unifiedLineCount,
    patch: file.patch,
    additionLines: [...file.additionLines],
    deletionLines: [...file.deletionLines],
    expansionSide: reviewExpansionSide(file.changeKind),
    ...(file.hunks.length === 0
      ? {
          emptyDiffReason: reviewEmptyDiffReason({
            changeKind: file.changeKind,
            binary: file.flags.binary,
            tooLarge: file.flags.tooLarge,
          }),
        }
      : {}),
    hunks: file.hunks.map((hunk, index) => {
      const leadingGap = reviewLeadingGap(gapSource, index);
      return {
        index,
        oldRange: reviewHunkRange(hunk, "old"),
        newRange: reviewHunkRange(hunk, "new"),
        defaultNoteTarget: reviewDefaultHunkLineTarget(hunk),
        blocks: hunk.hunkContent.map((block) => ({ ...block })),
        ...(leadingGap ? { leadingGap: manifestGap(leadingGap) } : {}),
      };
    }),
    ...(trailingGap ? { trailingGap: manifestGap(trailingGap) } : {}),
  };
}

/** Build the deterministic semantic snapshot of one projected review document. */
export function buildReviewContentManifest(document: ReviewDocumentV1): ReviewContentManifest {
  return { version: 1, files: document.files.map(buildReviewContentManifestFile) };
}
