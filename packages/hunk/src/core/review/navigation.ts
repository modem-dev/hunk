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
import {
  reviewChangeBlockContainsLine,
  reviewHunkChangeBlocks,
  type ReviewChangeBlockSpan,
  type ReviewHunkContent,
  type ReviewHunkSpan,
} from "./geometry";
import type { ReviewRevealRequest, ReviewSemanticSelection } from "./state";
import type { ReviewLineAddressV1 } from "./types";

export type ReviewSelectionScope =
  | "hunk"
  | "file"
  | "note"
  | "annotated-hunk"
  | "annotated-file"
  | "change-block"
  | "comment-thread";

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
  note: "clamp",
  "annotated-hunk": "clamp",
  "annotated-file": "wrap",
  "change-block": "clamp",
  "comment-thread": "clamp",
});

/** One navigable file, reduced to what a walk over the stream needs. */
export interface ReviewNavigationFile {
  fileKey: string;
  hunkCount: number;
  /** Optional sparse hunk positions for a terminal presentation projection. */
  hunkIndexes?: readonly number[];
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

/** One change block in the flattened review stream. */
export interface ReviewChangeBlockCursor extends ReviewChangeBlockSpan {
  fileKey: string;
  hunkIndex: number;
}

/** One comment-thread stop: a visible stored-note root or one sidecar annotation. */
export interface ReviewThreadCursor {
  fileKey: string;
  hunkIndex: number;
  /** The line the thread's card hangs beside. */
  line: ReviewLineAddressV1;
  /** Stored note id for a stored root; `reviewSidecarThreadId` for a sidecar annotation. */
  threadId: string;
  kind: "stored" | "sidecar";
}

/**
 * Where the reviewer stands inside the selected hunk, for moves finer than a hunk.
 *
 * A caller-owned fact: the semantic selection names only a file and hunk, while the line
 * the reviewer is on belongs to whichever surface drew it.
 */
export interface ReviewNavigationFocus {
  fileKey: string;
  hunkIndex: number;
  /** Omitted when the surface has no line; the move then starts at the top of the hunk. */
  line?: ReviewLineAddressV1;
}

/** The finer-than-hunk stop a change-block or comment-thread move landed on. */
export type ReviewMoveLanding =
  | { kind: "change-block"; block: ReviewChangeBlockSpan }
  | {
      kind: "comment-thread";
      threadId: string;
      threadKind: ReviewThreadCursor["kind"];
      line: ReviewLineAddressV1;
    };

/** Where one planned move lands, and what it asks the viewport to show. */
export interface ReviewSelectionMoveTarget {
  fileKey: string;
  hunkIndex: number;
  reveal: ReviewRevealRequest;
  /** Stable stored-note identity set only by exact-note navigation. */
  activeNoteId?: string;
  /** Set only by change-block and comment-thread moves, which stop inside a hunk. */
  landing?: ReviewMoveLanding;
}

/** One stored-note stop in the flattened review stream. */
export interface ReviewNoteCursor extends ReviewHunkCursor {
  noteId: string;
}

export interface ReviewNavigationModel {
  /** Navigable files in review order — the visible stream, not the whole document. */
  files: readonly ReviewNavigationFile[];
  annotations: ReviewAnnotationIndex;
  /** Visible stored notes in exact rendered order; sidecar-only annotations stay excluded. */
  notes?: readonly ReviewNoteCursor[];
  /** Effective stored-note identity from which an exact-note move begins. */
  activeNoteId?: string;
  /** Visible change blocks in stream order, for change-block moves. */
  changeBlocks?: readonly ReviewChangeBlockCursor[];
  /** Visible comment threads in stream order, for comment-thread moves. */
  threads?: readonly ReviewThreadCursor[];
  /** Thread the reviewer is on, from which a comment-thread move steps. */
  activeThreadId?: string;
  /** Line the reviewer is on, from which a finer-than-hunk move starts when no stop is active. */
  focus?: ReviewNavigationFocus;
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
    (
      file.hunkIndexes ?? Array.from({ length: file.hunkCount }, (_unused, hunkIndex) => hunkIndex)
    ).map((hunkIndex) => ({ fileKey: file.fileKey, hunkIndex })),
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
    return (
      file.hunkIndexes ?? Array.from({ length: file.hunkCount }, (_unused, hunkIndex) => hunkIndex)
    )
      .map((hunkIndex) => ({ fileKey: file.fileKey, hunkIndex }))
      .filter((cursor) => annotated.has(cursor.hunkIndex));
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
    hunkIndex: nextFile.hunkIndexes?.[0] ?? REVIEW_FILE_JUMP_HUNK_INDEX,
    reveal: REVIEW_FILE_JUMP_REVEAL,
  };
}

/** Plan a clamped move through exact stored notes in their rendered order. */
export function planReviewNoteMove(
  files: readonly ReviewNavigationFile[],
  cursors: readonly ReviewNoteCursor[],
  selection: ReviewSemanticSelection,
  activeNoteId: string | undefined,
  delta: number,
): ReviewSelectionMoveTarget | null {
  if (cursors.length === 0 || delta === 0) {
    return null;
  }

  const activeIndex = activeNoteId
    ? cursors.findIndex((cursor) => cursor.noteId === activeNoteId)
    : -1;
  let nextIndex: number;
  if (activeIndex >= 0) {
    nextIndex = clamp(activeIndex + delta, 0, cursors.length - 1);
    if (nextIndex === activeIndex) {
      return null;
    }
  } else {
    const fileOrder = new Map(files.map((file, index) => [file.fileKey, index] as const));
    const selectedFileOrder =
      selection.fileKey === null
        ? delta > 0
          ? -1
          : fileOrder.size
        : fileOrder.get(selection.fileKey);
    if (selectedFileOrder === undefined) {
      nextIndex = delta > 0 ? 0 : cursors.length - 1;
    } else if (delta > 0) {
      const firstAfter = cursors.findIndex((cursor) => {
        const order = fileOrder.get(cursor.fileKey) ?? -1;
        return (
          order > selectedFileOrder ||
          (order === selectedFileOrder && cursor.hunkIndex >= selection.hunkIndex)
        );
      });
      if (firstAfter < 0) return null;
      nextIndex = Math.min(firstAfter + delta - 1, cursors.length - 1);
    } else {
      let firstBefore = -1;
      for (let index = cursors.length - 1; index >= 0; index -= 1) {
        const cursor = cursors[index]!;
        const order = fileOrder.get(cursor.fileKey) ?? -1;
        if (
          order < selectedFileOrder ||
          (order === selectedFileOrder && cursor.hunkIndex <= selection.hunkIndex)
        ) {
          firstBefore = index;
          break;
        }
      }
      if (firstBefore < 0) return null;
      nextIndex = Math.max(0, firstBefore + delta + 1);
    }
  }

  const target = cursors[nextIndex];
  return target
    ? {
        fileKey: target.fileKey,
        hunkIndex: target.hunkIndex,
        activeNoteId: target.noteId,
        reveal: { anchor: "hunk", scrollToNote: true },
      }
    : null;
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
    hunkIndex: nextFile.hunkIndexes?.[0] ?? REVIEW_FILE_JUMP_HUNK_INDEX,
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
    case "note":
      return planReviewNoteMove(
        model.files,
        model.notes ?? [],
        selection,
        model.activeNoteId,
        move.delta,
      );
    case "annotated-hunk":
      return planAnnotatedHunkMove(model, selection, move.delta);
    case "annotated-file":
      return planAnnotatedFileMove(model, selection, move.delta);
    case "change-block":
      return planChangeBlockMove(model, selection, move.delta);
    case "comment-thread":
      return planCommentThreadMove(model, selection, move.delta);
  }
}

/** Flatten every visible hunk's change blocks into one top-to-bottom cursor list. */
export function reviewChangeBlockCursors(
  files: ReadonlyArray<{
    fileKey: string;
    hunks: readonly (ReviewHunkSpan & ReviewHunkContent)[];
    hunkIndexes?: readonly number[];
  }>,
): ReviewChangeBlockCursor[] {
  return files.flatMap((file) =>
    (file.hunkIndexes ?? file.hunks.map((_hunk, hunkIndex) => hunkIndex)).flatMap((hunkIndex) => {
      const hunk = file.hunks[hunkIndex];
      return hunk
        ? reviewHunkChangeBlocks(hunk).map((block) => ({
            ...block,
            fileKey: file.fileKey,
            hunkIndex,
          }))
        : [];
    }),
  );
}

/** Where a fine-grained move starts: the focus position, or the top of the selected hunk. */
function navigationStart(
  model: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
): ReviewNavigationFocus | null {
  if (model.focus) return model.focus;
  return selection.fileKey === null
    ? null
    : { fileKey: selection.fileKey, hunkIndex: selection.hunkIndex };
}

/**
 * Pick the landing index for a stop list given each stop's place relative to the start.
 *
 * `relation` is negative for a stop above the start, zero for the stop the start is on, and
 * positive for one below. Standing on a stop moves by exactly `delta` and clamps; standing
 * between stops reaches the nearest one in the direction of travel and spends what is left of
 * the count from there. Nothing ahead in that direction refuses the move rather than jumping
 * backward. A start outside the stream enters it from the edge it is moving toward.
 */
function landingIndex(relations: readonly number[] | null, length: number, delta: number) {
  if (!relations) {
    return delta > 0 ? 0 : length - 1;
  }

  const current = relations.indexOf(0);
  if (current >= 0) {
    return clamp(current + delta, 0, length - 1);
  }

  if (delta > 0) {
    const next = relations.findIndex((relation) => relation > 0);
    return next < 0 ? null : Math.min(next + delta - 1, length - 1);
  }

  let previous = -1;
  for (let index = relations.length - 1; index >= 0; index -= 1) {
    if (relations[index]! < 0) {
      previous = index;
      break;
    }
  }
  return previous < 0 ? null : Math.max(0, previous + delta + 1);
}

/** Compare two stream files by review order. */
function fileOrderDelta(
  fileOrder: ReadonlyMap<string, number>,
  fileKey: string,
  startFileKey: string,
) {
  return (fileOrder.get(fileKey) ?? 0) - (fileOrder.get(startFileKey) ?? 0);
}

/**
 * Plan a move through every change block of the visible stream.
 *
 * A start line inside a block stands on it; a line in surrounding context sits between
 * blocks, so the first step reaches the next edit. Without a line, the start is the top of
 * the selected hunk.
 */
function planChangeBlockMove(
  model: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
  delta: number,
): ReviewSelectionMoveTarget | null {
  const blocks = model.changeBlocks ?? [];
  if (blocks.length === 0 || delta === 0) {
    return null;
  }

  const fileOrder = new Map(model.files.map((file, index) => [file.fileKey, index] as const));
  const start = navigationStart(model, selection);
  const relations =
    start && fileOrder.has(start.fileKey)
      ? blocks.map((block) => {
          const byFile = fileOrderDelta(fileOrder, block.fileKey, start.fileKey);
          if (byFile !== 0) return Math.sign(byFile);
          if (!start.line) return block.hunkIndex < start.hunkIndex ? -1 : 1;
          if (reviewChangeBlockContainsLine(block, start.line)) return 0;
          const blockStart = start.line.side === "new" ? block.newStart : block.oldStart;
          return start.line.line < blockStart ? 1 : -1;
        })
      : null;

  const index = landingIndex(relations, blocks.length, delta);
  const block = index === null ? undefined : blocks[index];
  if (!block) {
    return null;
  }

  const { fileKey, hunkIndex, ...span } = block;
  return {
    fileKey,
    hunkIndex,
    reveal: { anchor: "hunk", scrollToNote: false },
    landing: { kind: "change-block", block: span },
  };
}

/**
 * Plan a move through comment threads, one stop per thread root.
 *
 * An active thread moves by exactly `delta` and stops at the ends. Otherwise the start
 * position decides: a card hangs below its anchor row, so a start on that row is still above
 * the thread and the first forward step lands on it.
 */
function planCommentThreadMove(
  model: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
  delta: number,
): ReviewSelectionMoveTarget | null {
  const threads = model.threads ?? [];
  if (threads.length === 0 || delta === 0) {
    return null;
  }

  const active = model.activeThreadId
    ? threads.findIndex((thread) => thread.threadId === model.activeThreadId)
    : -1;
  let index: number | null;
  if (active >= 0) {
    index = clamp(active + delta, 0, threads.length - 1);
    if (index === active) {
      return null;
    }
  } else {
    const fileOrder = new Map(model.files.map((file, order) => [file.fileKey, order] as const));
    const start = navigationStart(model, selection);
    const relations =
      start && fileOrder.has(start.fileKey)
        ? threads.map((thread) => {
            const byFile = fileOrderDelta(fileOrder, thread.fileKey, start.fileKey);
            if (byFile !== 0) return Math.sign(byFile);
            if (thread.hunkIndex !== start.hunkIndex) {
              return thread.hunkIndex < start.hunkIndex ? -1 : 1;
            }
            if (!start.line) return 1;
            return thread.line.line >= start.line.line ? 1 : -1;
          })
        : null;
    index = landingIndex(relations, threads.length, delta);
  }

  const thread = index === null ? undefined : threads[index];
  if (!thread) {
    return null;
  }

  return {
    fileKey: thread.fileKey,
    hunkIndex: thread.hunkIndex,
    reveal: { anchor: "hunk", scrollToNote: true },
    ...(thread.kind === "stored" ? { activeNoteId: thread.threadId } : {}),
    landing: {
      kind: "comment-thread",
      threadId: thread.threadId,
      threadKind: thread.kind,
      line: thread.line,
    },
  };
}
