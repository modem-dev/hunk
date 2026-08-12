/**
 * Answers the questions about review state that more than one consumer asks.
 *
 * State changes go through the reducer; shared questions go through here, so two
 * consumers cannot answer "is this gap expanded" or "what does this clear touch"
 * differently. Selectors stay pure functions of state, and the ones that encode a rule
 * rather than a lookup say so by name.
 */
import type { ReviewState, ReviewStoredNote } from "./state";
import type { ReviewDocumentV1, ReviewFileV1 } from "./types";

/** Select one semantic file by key. */
export function selectReviewFileByKey(
  state: Pick<ReviewState, "document">,
  fileKey: string | null,
): ReviewFileV1 | undefined {
  return fileKey === null ? undefined : state.document.files.find((file) => file.key === fileKey);
}

/**
 * Scope policy for a bulk note clear: naming no file clears the whole review.
 *
 * The reducer removes what this covers and the intent counts it, so "which notes does
 * this clear touch" cannot be answered two ways.
 */
export function isReviewNoteWithinClearScope(entry: ReviewStoredNote, fileKey?: string) {
  return fileKey === undefined || entry.note.fileKey === fileKey;
}

/**
 * Content-retirement policy: which files' content-derived state a new document voids.
 *
 * Expansion and loaded source text describe content, not a path. A file that disappears,
 * or that comes back backed by different source content, must not keep answering with
 * the lines the previous load produced.
 */
export function reviewFileKeysWithRetiredContent(
  previous: ReviewDocumentV1,
  next: ReviewDocumentV1,
): ReadonlySet<string> {
  const nextByKey = new Map(next.files.map((file) => [file.key, file] as const));
  return new Set(
    previous.files
      .filter((file) => {
        const replacement = nextByKey.get(file.key);
        return !replacement || replacement.sourceIdentity !== file.sourceIdentity;
      })
      .map((file) => file.key),
  );
}

/** Return whether one collapsed gap is currently expanded. */
export function isReviewGapExpanded(
  state: Pick<ReviewState, "expandedGaps">,
  fileKey: string,
  gapId: string,
) {
  return state.expandedGaps.some(
    (gap) => gap.fileKey === fileKey && gap.gapId === gapId && gap.expanded,
  );
}

/** Select the expanded gap ids of every file that currently has any. */
export function selectExpandedGapIdsByFileKey(
  state: Pick<ReviewState, "expandedGaps">,
): Record<string, ReadonlySet<string>> {
  const result: Record<string, Set<string>> = {};
  for (const gap of state.expandedGaps) {
    const gaps = (result[gap.fileKey] ??= new Set());
    if (gap.expanded) {
      gaps.add(gap.gapId);
    } else {
      gaps.delete(gap.gapId);
    }
  }
  return result;
}
