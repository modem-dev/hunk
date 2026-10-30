/**
 * The semantic review document: how a parsed changeset becomes the model every consumer
 * reads, and what that model says about a file with nothing to render.
 *
 * Projection is the boundary where renderer-owned facts (a parser's metadata objects, a
 * loader's fetcher) turn into plain values addressed by content. Everything downstream —
 * the store, the terminal's note projection, later a transport — reads the result rather
 * than the diff model behind it.
 *
 * Publication concerns (generations, resource descriptors, byte digests) do not appear:
 * they belong to the producer runtime that serves a document, not to the document itself.
 */
import type { DiffFile } from "../changeset/model";
import {
  reviewFileContentIdentity,
  reviewFileKey,
  reviewSourceIdentity,
  type ReviewFileContentIdentityInput,
} from "./identity";
import type {
  ReviewDocumentV1,
  ReviewFileChangeKind,
  ReviewFileV1,
  ReviewHunkBlockV1,
  ReviewHunkV1,
} from "./types";

/** Convert one parsed hunk into an explicit JSON-safe semantic record. */
export function projectReviewHunk(
  hunk: DiffFile["metadata"]["hunks"][number],
  index: number,
): ReviewHunkV1 {
  return {
    index,
    collapsedBefore: hunk.collapsedBefore,
    splitLineStart: hunk.splitLineStart,
    splitLineCount: hunk.splitLineCount,
    unifiedLineStart: hunk.unifiedLineStart,
    unifiedLineCount: hunk.unifiedLineCount,
    additionStart: hunk.additionStart,
    additionCount: hunk.additionCount,
    additionLines: hunk.additionLines,
    additionLineIndex: hunk.additionLineIndex,
    deletionStart: hunk.deletionStart,
    deletionCount: hunk.deletionCount,
    deletionLines: hunk.deletionLines,
    deletionLineIndex: hunk.deletionLineIndex,
    hunkContent: hunk.hunkContent.map(
      (content): ReviewHunkBlockV1 =>
        content.type === "context"
          ? {
              type: "context",
              lines: content.lines,
              additionLineIndex: content.additionLineIndex,
              deletionLineIndex: content.deletionLineIndex,
            }
          : {
              type: "change",
              additions: content.additions,
              deletions: content.deletions,
              additionLineIndex: content.additionLineIndex,
              deletionLineIndex: content.deletionLineIndex,
            },
    ),
    ...(hunk.hunkSpecs !== undefined ? { hunkSpecs: hunk.hunkSpecs } : {}),
    ...(hunk.hunkContext !== undefined ? { hunkContext: hunk.hunkContext } : {}),
    noEOFCRAdditions: Boolean(hunk.noEOFCRAdditions),
    noEOFCRDeletions: Boolean(hunk.noEOFCRDeletions),
  };
}

/** Summarize hunk geometry for identity, so a re-parse at another context width differs. */
function hunkSignature(hunks: readonly ReviewHunkV1[]) {
  return hunks
    .map((hunk) =>
      [
        hunk.collapsedBefore,
        hunk.additionStart,
        hunk.additionCount,
        hunk.additionLineIndex,
        hunk.deletionStart,
        hunk.deletionCount,
        hunk.deletionLineIndex,
      ].join(","),
    )
    .join(";");
}

/** Collect the renderer-neutral facts one file's content identity is hashed from. */
function contentIdentityInput(
  file: DiffFile,
  hunks: readonly ReviewHunkV1[],
): ReviewFileContentIdentityInput {
  return {
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    changeKind: file.metadata.type,
    ...(file.language !== undefined ? { language: file.language } : {}),
    patch: file.patch,
    stats: {
      additions: file.stats.additions,
      deletions: file.stats.deletions,
      truncated: Boolean(file.statsTruncated),
    },
    flags: {
      untracked: Boolean(file.isUntracked),
      binary: Boolean(file.isBinary),
      tooLarge: Boolean(file.isTooLarge),
      partial: Boolean(file.metadata.isPartial),
    },
    hunkSignature: hunkSignature(hunks),
    additionLines: file.metadata.additionLines,
    deletionLines: file.metadata.deletionLines,
  };
}

export interface ProjectReviewDocumentOptions {
  /**
   * Identity of the review's input as a whole. Two different changesets projecting the
   * same file content still address it by different keys.
   */
  sourceLabel?: string;
}

/** Project one diff file into the semantic file the review model addresses. */
function projectReviewFile(file: DiffFile, sourceLabel: string, duplicateIndex: number) {
  const hunks = file.metadata.hunks.map(projectReviewHunk);
  const identityInput = contentIdentityInput(file, hunks);
  const contentIdentity = reviewFileContentIdentity(identityInput);
  const sourceIdentity = file.sourceFetcher
    ? reviewSourceIdentity({
        path: file.path,
        contentIdentity,
        ...(file.sourceFetcher.cacheKey !== undefined
          ? { fetcherCacheKey: file.sourceFetcher.cacheKey }
          : {}),
      })
    : undefined;
  // Without a fetcher cache key, an unchanged identity proves only that the *diff* did not
  // move — the full source behind it may have (a rebase shifting base and working tree in
  // lockstep). Only a reader that names its snapshot can attest the text itself.
  const sourceAttested = file.sourceFetcher?.cacheKey !== undefined;

  return {
    key: reviewFileKey({
      sourceLabel,
      path: file.path,
      ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
      duplicateIndex,
    }),
    runtimeId: file.id,
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    changeKind: identityInput.changeKind as ReviewFileChangeKind,
    ...(file.language !== undefined ? { language: file.language } : {}),
    ...(file.agent?.summary !== undefined ? { agentSummary: file.agent.summary } : {}),
    stats: identityInput.stats,
    flags: identityInput.flags,
    patch: file.patch,
    splitLineCount: file.metadata.splitLineCount,
    unifiedLineCount: file.metadata.unifiedLineCount,
    // Copied, not referenced: an extension that retains and later mutates the model it
    // returned must not change a document the store already published.
    additionLines: [...file.metadata.additionLines],
    deletionLines: [...file.metadata.deletionLines],
    ...(file.lineMoveKinds
      ? {
          lineMoveKinds: {
            additionLines: file.lineMoveKinds.additionLines.map((kind) => kind ?? null),
            deletionLines: file.lineMoveKinds.deletionLines.map((kind) => kind ?? null),
          },
        }
      : {}),
    hunks,
    contentIdentity,
    ...(sourceIdentity !== undefined ? { sourceIdentity, sourceAttested } : {}),
  } satisfies ReviewFileV1;
}

/**
 * Project one ordered list of diff files into the semantic review document.
 *
 * File order is the review's order and is preserved exactly. Keys address a file within
 * the review and survive a reload that changed it; content identity is what tells a
 * consumer whether the content behind that address moved.
 */
export function projectReviewDocument(
  files: readonly DiffFile[],
  { sourceLabel = "" }: ProjectReviewDocumentOptions = {},
): ReviewDocumentV1 {
  const occurrences = new Map<string, number>();
  return {
    files: files.map((file) => {
      // One path can legitimately appear twice in a changeset; the occurrence keeps the
      // two entries addressable apart.
      const occurrence = occurrences.get(file.path) ?? 0;
      occurrences.set(file.path, occurrence + 1);
      return projectReviewFile(file, sourceLabel, occurrence);
    }),
  };
}

export type ReviewEmptyDiffReason =
  | "rename-only"
  | "binary"
  | "too-large"
  | "new-file"
  | "deleted-file"
  | "no-hunks";

export interface ReviewEmptyDiffSubject {
  changeKind: ReviewFileChangeKind;
  binary: boolean;
  tooLarge: boolean;
}

/**
 * Why one file shows no diff rows.
 *
 * Canonical precedence: what the change *is* outranks how it is stored, so a pure rename
 * explains itself as a rename even when the renamed bytes are binary or oversized. Each
 * surface still writes its own wording; only the reason is shared, so two clients cannot
 * explain the same file differently (A8).
 *
 * Meaningful only for a file with nothing rendered — a file with hunks needs no excuse.
 */
export function reviewEmptyDiffReason({
  changeKind,
  binary,
  tooLarge,
}: ReviewEmptyDiffSubject): ReviewEmptyDiffReason {
  if (changeKind === "rename-pure") {
    return "rename-only";
  }
  if (binary) {
    return "binary";
  }
  if (tooLarge) {
    return "too-large";
  }
  if (changeKind === "new") {
    return "new-file";
  }
  if (changeKind === "deleted") {
    return "deleted-file";
  }
  return "no-hunks";
}
