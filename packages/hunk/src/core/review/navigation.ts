/**
 * Relative navigation over the review stream: where one move lands, and what it reveals.
 *
 * A reviewer stepping to the next hunk, the previous file, or the next annotated hunk is
 * asking the same question every surface has to answer — the terminal's keyboard, the
 * agent session's `--next-comment`, and later a browser client. The prototype answered it
 * three times over (`docs/browser-review-seam-audit.md`, B1), so the walk lives here once
 * and every surface plans through it.
 *
 * Two rules are stated rather than implied, because the previous copies disagreed about
 * both:
 *
 * - **Wrap policy is per scope** (B2). Plain hunk and file navigation clamps at the ends
 *   of the stream; annotated-file navigation cycles. That asymmetry is the terminal's
 *   long-standing behavior and is named here instead of falling out of whichever
 *   arithmetic each copy happened to use.
 * - **A move carries its own reveal request** (B3). "Next hunk" crossing forward into
 *   another file puts that file's header on screen; crossing backward reveals the hunk
 *   itself; annotated-hunk navigation asks for the note. Callers do not re-decide this.
 *
 * The model this plans over is structural — file keys and hunk counts, plus an annotation
 * index the consumer supplies. Which hunks count as annotated depends on note sources the
 * semantic document does not carry (an imported sidecar, a renderer's merged live
 * comments), so it arrives as a caller-owned fact rather than being guessed.
 */
import type { ReviewRevealRequest, ReviewSemanticSelection } from "./state";

export type ReviewSelectionScope = "hunk" | "file" | "annotated-hunk" | "annotated-file";

/** What a move does when it runs off the end of the stream it walks. */
export type ReviewSelectionWrapPolicy = "clamp" | "wrap";

/**
 * The wrap policy each scope navigates under.
 *
 * Clamping is the default because hunk and file navigation double as "am I at the end
 * yet?"; annotated-file navigation cycles because a review with two annotated files is a
 * ring the reviewer tours rather than a list they walk off.
 */
export const REVIEW_SELECTION_WRAP_POLICY: Readonly<
  Record<ReviewSelectionScope, ReviewSelectionWrapPolicy>
> = Object.freeze({
  hunk: "clamp",
  file: "clamp",
  "annotated-hunk": "clamp",
  "annotated-file": "wrap",
});

/** One navigable file, reduced to what a walk over the stream needs. */
export interface ReviewNavigationFile {
  fileKey: string;
  hunkCount: number;
}

/**
 * Which files and hunks currently carry notes.
 *
 * A caller-owned fact: notes reach a review from several places (a sidecar loaded with the
 * changeset, live agent comments, the reviewer's own notes), and only the consumer that
 * merged them knows the full set. File-level and hunk-level membership are separate
 * entries on purpose — a file can carry review context without any note landing inside a
 * hunk, and annotated-file navigation has always visited it.
 */
export interface ReviewAnnotationIndex {
  annotatedHunkIndicesByFileKey: ReadonlyMap<string, ReadonlySet<number>>;
  annotatedFileKeys: ReadonlySet<string>;
}

/** An empty annotation index, for a review that has no notes at all. */
export const EMPTY_REVIEW_ANNOTATION_INDEX: ReviewAnnotationIndex = Object.freeze({
  annotatedHunkIndicesByFileKey: new Map<string, ReadonlySet<number>>(),
  annotatedFileKeys: new Set<string>(),
});

/** One addressable position in the flattened review stream. */
export interface ReviewHunkCursor {
  fileKey: string;
  hunkIndex: number;
}

export interface ReviewSelectionMove {
  scope: ReviewSelectionScope;
  /** Signed step count; magnitude repeats the move, sign chooses the direction. */
  delta: number;
}

/** Where one planned move lands, and what it asks the viewport to show. */
export interface ReviewSelectionMoveTarget {
  fileKey: string;
  hunkIndex: number;
  reveal: ReviewRevealRequest;
}

export interface ReviewNavigationModel {
  /** Navigable files in review order — the visible stream, not the whole document. */
  files: readonly ReviewNavigationFile[];
  annotations: ReviewAnnotationIndex;
}

/**
 * The reveal a file jump asks for: put the file's header on screen.
 *
 * Selecting a file is a jump to somewhere else in the review, so the reviewer needs the
 * landmark that tells them where they arrived rather than a hunk floating mid-viewport.
 */
export const REVIEW_FILE_JUMP_REVEAL: ReviewRevealRequest = Object.freeze({
  anchor: "file-top",
  scrollToNote: false,
});

/** Selecting a file selects its first hunk; nothing else would be a defined position. */
export const REVIEW_FILE_JUMP_HUNK_INDEX = 0;

/** Clamp one index into an inclusive range. */
export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Compare two stream positions. */
function cursorMatches(cursor: ReviewHunkCursor, selection: ReviewSemanticSelection) {
  return cursor.fileKey === selection.fileKey && cursor.hunkIndex === selection.hunkIndex;
}

/** Flatten every hunk of every navigable file into one top-to-bottom cursor list. */
export function reviewStreamCursors(files: readonly ReviewNavigationFile[]): ReviewHunkCursor[] {
  return files.flatMap((file) =>
    Array.from({ length: file.hunkCount }, (_unused, hunkIndex) => ({
      fileKey: file.fileKey,
      hunkIndex,
    })),
  );
}

/** Flatten only the hunks carrying notes, in the same top-to-bottom order. */
export function reviewAnnotatedCursors(
  files: readonly ReviewNavigationFile[],
  annotations: ReviewAnnotationIndex,
): ReviewHunkCursor[] {
  return files.flatMap((file) => {
    const annotated = annotations.annotatedHunkIndicesByFileKey.get(file.fileKey);
    if (!annotated || annotated.size === 0) {
      return [];
    }
    return Array.from({ length: file.hunkCount }, (_unused, hunkIndex) => ({
      fileKey: file.fileKey,
      hunkIndex,
    })).filter((cursor) => annotated.has(cursor.hunkIndex));
  });
}

/** The files annotated-file navigation tours, in review order. */
function annotatedFiles(
  files: readonly ReviewNavigationFile[],
  annotations: ReviewAnnotationIndex,
) {
  return files.filter((file) => annotations.annotatedFileKeys.has(file.fileKey));
}

/**
 * Resolve a move whose starting position is not itself in the cursor subset.
 *
 * Annotated navigation walks a subset of the stream, so the reviewer is usually standing
 * between two of its entries. The rule is "reach the nearest entry in the direction of
 * travel, then spend what is left of the step count" — a repeat count must not be
 * swallowed by the approach, and must not overshoot past the end either, since annotated
 * navigation clamps like the plain kind.
 */
function nearestCursorIndex(
  cursors: readonly ReviewHunkCursor[],
  streamCursors: readonly ReviewHunkCursor[],
  selection: ReviewSemanticSelection,
  delta: number,
) {
  const edgeIndex = delta >= 0 ? 0 : cursors.length - 1;
  if (selection.fileKey === null) {
    return edgeIndex;
  }

  const currentStreamIndex = streamCursors.findIndex((cursor) => cursorMatches(cursor, selection));
  if (currentStreamIndex < 0) {
    return edgeIndex;
  }

  const streamIndexByCursor = new Map(
    streamCursors.map(
      (cursor, index) => [`${cursor.fileKey}\0${cursor.hunkIndex}`, index] as const,
    ),
  );
  const indexedCursors = cursors
    .map((cursor, index) => ({
      index,
      streamIndex: streamIndexByCursor.get(`${cursor.fileKey}\0${cursor.hunkIndex}`) ?? -1,
    }))
    .filter(({ streamIndex }) => streamIndex >= 0);
  if (indexedCursors.length === 0) {
    return edgeIndex;
  }

  const remainingSteps = Math.max(0, Math.abs(delta) - 1);
  if (delta >= 0) {
    const nextCursor = indexedCursors.find(({ streamIndex }) => streamIndex > currentStreamIndex);
    const nearestIndex = nextCursor?.index ?? indexedCursors[indexedCursors.length - 1]!.index;
    return Math.min(nearestIndex + remainingSteps, cursors.length - 1);
  }

  for (let index = indexedCursors.length - 1; index >= 0; index -= 1) {
    const indexedCursor = indexedCursors[index]!;
    if (indexedCursor.streamIndex < currentStreamIndex) {
      return Math.max(0, indexedCursor.index - remainingSteps);
    }
  }

  return 0;
}

/**
 * Step through one cursor list under the clamping policy.
 *
 * A position inside the list moves by exactly `delta` and stops at the ends; a position
 * outside it lands through the nearest-then-carry rule above.
 */
function stepCursors(
  cursors: readonly ReviewHunkCursor[],
  streamCursors: readonly ReviewHunkCursor[],
  selection: ReviewSemanticSelection,
  delta: number,
): ReviewHunkCursor | null {
  if (cursors.length === 0) {
    return null;
  }

  const currentIndex = cursors.findIndex((cursor) => cursorMatches(cursor, selection));
  const nextIndex =
    currentIndex >= 0
      ? clamp(currentIndex + delta, 0, cursors.length - 1)
      : nearestCursorIndex(cursors, streamCursors, selection, delta);
  return cursors[nextIndex] ?? null;
}

/** Plan a move through every hunk of the visible stream. */
function planHunkMove(
  model: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
  delta: number,
): ReviewSelectionMoveTarget | null {
  const cursors = reviewStreamCursors(model.files);
  const target = stepCursors(cursors, cursors, selection, delta);
  if (!target) {
    return null;
  }

  // Forward jumps into another file land on its header, so the reviewer sees which file
  // they entered. Backward jumps reveal the hunk itself: the target usually sits near the
  // bottom of the previous file, and a header alignment would leave it off screen.
  const crossesFileForward = target.fileKey !== selection.fileKey && delta > 0;
  return {
    ...target,
    reveal: { anchor: crossesFileForward ? "file-top" : "hunk", scrollToNote: false },
  };
}

/** Plan a move through every visible file, selecting its first hunk. */
function planFileMove(
  model: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
  delta: number,
): ReviewSelectionMoveTarget | null {
  const currentIndex = model.files.findIndex((file) => file.fileKey === selection.fileKey);
  // A selection outside the visible stream has no place to step from, and moving anyway
  // would teleport the reviewer somewhere they never navigated to.
  if (currentIndex < 0) {
    return null;
  }

  const nextIndex = clamp(currentIndex + delta, 0, model.files.length - 1);
  const nextFile = model.files[nextIndex];
  // Standing at either end is a no-op rather than a re-selection: file navigation must
  // not scroll the viewport back to the current file's header on a key that did nothing.
  if (nextIndex === currentIndex || !nextFile) {
    return null;
  }

  return {
    fileKey: nextFile.fileKey,
    hunkIndex: REVIEW_FILE_JUMP_HUNK_INDEX,
    reveal: REVIEW_FILE_JUMP_REVEAL,
  };
}

/** Plan a move through only the hunks carrying notes. */
function planAnnotatedHunkMove(
  model: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
  delta: number,
): ReviewSelectionMoveTarget | null {
  const target = stepCursors(
    reviewAnnotatedCursors(model.files, model.annotations),
    reviewStreamCursors(model.files),
    selection,
    delta,
  );
  // The note is what the reviewer asked to see; the hunk around it comes along with it.
  return target ? { ...target, reveal: { anchor: "hunk", scrollToNote: true } } : null;
}

/** Plan a cycle through only the files carrying notes. */
function planAnnotatedFileMove(
  model: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
  delta: number,
): ReviewSelectionMoveTarget | null {
  const files = annotatedFiles(model.files, model.annotations);
  if (files.length === 0) {
    return null;
  }

  // A reviewer standing on a file with no notes is treated as standing at the start of
  // the ring, so the first forward step lands on its second entry rather than its first.
  const currentIndex = files.findIndex((file) => file.fileKey === selection.fileKey);
  const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (((normalizedIndex + delta) % files.length) + files.length) % files.length;
  const nextFile = files[nextIndex];
  if (!nextFile) {
    return null;
  }

  // Deliberately not the file-jump reveal: touring annotated files shows the note-bearing
  // content, and starting each file at its header would push that content down the page.
  return {
    fileKey: nextFile.fileKey,
    hunkIndex: REVIEW_FILE_JUMP_HUNK_INDEX,
    reveal: { anchor: "hunk", scrollToNote: false },
  };
}

/**
 * Plan one relative selection move, or report that the review has nowhere to go.
 *
 * `null` means the move is refused — an empty stream, a scope with no members, or an edge
 * a clamping scope declines to re-select — and a refused move must leave both the
 * selection and the viewport exactly as they were.
 */
export function planReviewSelectionMove(
  model: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
  move: ReviewSelectionMove,
): ReviewSelectionMoveTarget | null {
  switch (move.scope) {
    case "hunk":
      return planHunkMove(model, selection, move.delta);
    case "file":
      return planFileMove(model, selection, move.delta);
    case "annotated-hunk":
      return planAnnotatedHunkMove(model, selection, move.delta);
    case "annotated-file":
      return planAnnotatedFileMove(model, selection, move.delta);
  }
}
