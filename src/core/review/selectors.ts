/**
 * Answers the questions about review state that more than one consumer asks.
 *
 * State changes go through the reducer; shared questions go through here, so two
 * consumers cannot answer "is this gap expanded" or "what does this clear touch"
 * differently. Selectors stay pure functions of state, and the ones that encode a rule
 * rather than a lookup say so by name.
 */
import { normalizeDiffPath } from "../diffPaths";
import {
  reviewGapId,
  reviewGapSourceForFile,
  reviewLeadingGap,
  reviewTrailingGap,
} from "./expansion";
import { reviewCanonicalHunkLine } from "./geometry";
import type { ReviewNavigationFile } from "./navigation";
import {
  isRenderableStoredReviewNote,
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  type ReviewSemanticSelection,
  type ReviewState,
  type ReviewStoredNote,
} from "./state";
import type { ReviewDocumentV1, ReviewFileV1, ReviewLineAddressV1, ReviewNoteV1 } from "./types";

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

/** The file facts the shared filter reads. */
export type ReviewFilterFile = Pick<ReviewFileV1, "path" | "previousPath" | "agentSummary">;

/**
 * Matches one file against the shared review filter.
 *
 * A query matches a file's current path, the path it came from, or the agent's summary of
 * it, case-insensitively. The fields are joined before matching, so a query may span the
 * boundary between them — that is the terminal's long-standing behavior, kept exactly
 * (`docs/browser-review-seam-audit.md`, B5), rather than three surfaces each searching a
 * different subset of the same file.
 *
 * Paths are normalized first: a parser leaving a stray carriage return on a path must not
 * decide whether that file matches.
 */
export function reviewFileMatchesFilter(file: ReviewFilterFile, filter: string) {
  const query = filter.trim().toLowerCase();
  if (!query) {
    return true;
  }

  return [normalizeDiffPath(file.path), normalizeDiffPath(file.previousPath), file.agentSummary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

/** Select the files the current filter leaves visible, in review order. */
export function selectVisibleReviewFiles(
  state: Pick<ReviewState, "document" | "filter">,
): ReviewFileV1[] {
  return state.document.files.filter((file) => reviewFileMatchesFilter(file, state.filter));
}

/** Reduce the visible stream to what relative navigation walks over. */
export function selectReviewNavigationFiles(
  state: Pick<ReviewState, "document" | "filter">,
): ReviewNavigationFile[] {
  return selectVisibleReviewFiles(state).map((file) => ({
    fileKey: file.key,
    hunkCount: file.hunks.length,
  }));
}

/**
 * The file a selection falls back to when its own file is gone.
 *
 * The first visible file, or nothing at all. "Nothing" is a real answer: a review whose
 * filter matches no file has no selection to offer, and inventing one would put the
 * reviewer somewhere they never asked to be.
 */
export function selectFallbackFileKey(
  state: Pick<ReviewState, "document" | "filter">,
): string | null {
  return selectVisibleReviewFiles(state)[0]?.key ?? null;
}

/**
 * The selection every consumer should read, normalized against the current document.
 *
 * Two rules, both of which the prototype's clients answered differently (B4):
 *
 * - A selected file the filter currently hides is still the selection. Filtering changes
 *   what the reviewer is browsing, not what they were last looking at, and quietly
 *   re-pointing the selection at another file would lose their place.
 * - A selected file the document no longer has falls back to the first visible file, and
 *   to nothing when there is none — never to a hidden file.
 *
 * The hunk index is clamped rather than rejected, so a stale index from a file that was
 * re-parsed smaller still lands on a real hunk.
 */
export function selectNormalizedSelection(
  state: Pick<ReviewState, "document" | "filter" | "selection">,
): ReviewSemanticSelection {
  const file = selectReviewFileByKey(state, state.selection.fileKey);
  if (!file) {
    return { fileKey: selectFallbackFileKey(state), hunkIndex: 0 };
  }

  return {
    fileKey: file.key,
    hunkIndex: Math.min(Math.max(state.selection.hunkIndex, 0), Math.max(0, file.hunks.length - 1)),
  };
}

/**
 * The line a reveal should bring into view for the current selection.
 *
 * Resolved from the selected hunk's backed sides rather than from whichever side happens
 * to report a range: every hunk has a position on both sides, so testing for a range
 * scrolls a pure-deletion hunk to a new-side line that does not exist (B6). Undefined
 * means the selection has no hunk to reveal, and the caller should reveal the file
 * instead.
 */
export function selectRevealTarget(
  state: Pick<ReviewState, "document" | "selection">,
): ReviewLineAddressV1 | undefined {
  const hunk = selectReviewFileByKey(state, state.selection.fileKey)?.hunks[
    state.selection.hunkIndex
  ];
  return hunk ? reviewCanonicalHunkLine(hunk) : undefined;
}

/** Every mutable note currently safe to render, live notes before the reviewer's own. */
function renderableNotes(state: Pick<ReviewState, "liveNotes" | "userNotes">): ReviewNoteV1[] {
  return [...state.liveNotes, ...state.userNotes]
    .filter(isRenderableStoredReviewNote)
    .map((entry) => entry.note);
}

/**
 * Group one file's notes by the hunk that renders them.
 *
 * Grouping reads the ownership the anchor resolver already decided; it never re-tests
 * range containment. A note core placed through its fallback path — one anchored to an
 * expanded context line, or to a range the current patch collapsed — has an owner but no
 * intersecting hunk, and a consumer that re-filters by containment drops it (B8).
 */
export function selectNotesByHunk(
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
  fileKey: string,
): ReadonlyMap<number, ReviewNoteV1[]> {
  const byHunk = new Map<number, ReviewNoteV1[]>();
  for (const note of renderableNotes(state)) {
    if (note.fileKey !== fileKey) {
      continue;
    }
    const hunkIndex = reviewNoteOwnerHunkIndex(note);
    const notes = byHunk.get(hunkIndex);
    if (notes) {
      notes.push(note);
    } else {
      byHunk.set(hunkIndex, [note]);
    }
  }
  return byHunk;
}

/**
 * Which note a "jump to the note" reveal targets.
 *
 * Named policy: an active draft in the selected hunk wins, because the reviewer is
 * writing it right now; otherwise the note whose anchor sits earliest in the hunk, with
 * arrival order breaking ties. Undefined means the selected hunk has nothing to reveal
 * and the caller should fall back to revealing the hunk itself.
 */
export function selectActiveRevealNoteId(
  state: Pick<ReviewState, "draftNote" | "liveNotes" | "selection" | "userNotes">,
): string | undefined {
  const { fileKey, hunkIndex } = state.selection;
  if (fileKey === null) {
    return undefined;
  }

  const draft = state.draftNote;
  if (draft && draft.fileKey === fileKey && draft.hunkIndex === hunkIndex) {
    return draft.id;
  }

  return renderableNotes(state)
    .filter((note) => note.fileKey === fileKey && reviewNoteOwnerHunkIndex(note) === hunkIndex)
    .map((note, arrival) => ({ note, arrival, line: reviewNoteAnchorLine(note).line }))
    .sort((left, right) => left.line - right.line || left.arrival - right.arrival)[0]?.note.id;
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

/** One collapsed gap, addressed the way an expansion intent names it. */
export interface ReviewGapTarget {
  fileKey: string;
  gapId: string;
}

/**
 * The gap a "toggle unchanged context" command acts on.
 *
 * Named policy, because "the nearest gap" has to mean the same thing wherever the command
 * is invoked from: the selected hunk's own leading gap first, then the leading gap of each
 * later hunk, and finally the file's trailing gap. Undefined means the selection reaches
 * no gap at all — a file with no collapsed context, or one whose content has no expandable
 * source behind it, which is a semantic fact (`sourceIdentity`) rather than a renderer's
 * knowledge of its fetcher.
 */
export function selectReviewGapForSelection(
  state: Pick<ReviewState, "document" | "filter" | "selection">,
): ReviewGapTarget | undefined {
  const { fileKey, hunkIndex } = selectNormalizedSelection(state);
  const file = selectReviewFileByKey(state, fileKey);
  if (!file || file.sourceIdentity === undefined || file.hunks.length === 0) {
    return undefined;
  }

  const gapSource = reviewGapSourceForFile(file);
  for (let index = hunkIndex; index < file.hunks.length; index += 1) {
    if (reviewLeadingGap(gapSource, index)) {
      return { fileKey: file.key, gapId: reviewGapId("before", index) };
    }
  }

  const trailing = reviewTrailingGap(gapSource);
  return trailing
    ? { fileKey: file.key, gapId: reviewGapId("trailing", trailing.hunkIndex) }
    : undefined;
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
