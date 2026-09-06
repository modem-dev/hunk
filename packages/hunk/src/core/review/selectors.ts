/**
 * Answers the questions about review state that more than one consumer asks.
 *
 * State changes go through the reducer; shared questions go through here, so two
 * consumers cannot answer "is this gap expanded" or "what does this clear touch"
 * differently. Selectors stay pure functions of state, and the ones that encode a rule
 * rather than a lookup say so by name.
 */
import { normalizeDiffPath } from "../changeset/diffPaths";
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
  reviewNoteVisibleByPolicy,
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

/** Resolve stored note ownership against the hunk geometry that exists now. */
export function reviewNoteCurrentOwnerHunkIndex(note: ReviewNoteV1, file: ReviewFileV1) {
  const stored = reviewNoteOwnerHunkIndex(note);
  return Math.min(Math.max(stored, 0), Math.max(0, file.hunks.length - 1));
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

/**
 * Return every saved mutable note, live arrival order before reviewer creation order.
 *
 * Unlike render selectors, this preserves stale and orphaned entries: exporters and other
 * authoritative consumers must decide how to report an unplaced note rather than losing it.
 * Drafts are separate state and never appear here.
 */
export function selectStoredReviewNotes(
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): ReviewStoredNote[] {
  return [...state.liveNotes, ...state.userNotes];
}

/** Find one semantically stored note by its stable identity. */
export function selectStoredReviewNoteById(
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
  noteId: string,
): ReviewStoredNote | undefined {
  return selectStoredReviewNotes(state).find((entry) => entry.note.id === noteId);
}

/** One stored note annotated with its derived place in a reply tree. */
export interface ReviewThreadedStoredNote {
  entry: ReviewStoredNote;
  rootId: string;
  depth: number;
  parentId?: string;
}

/**
 * Flatten stored note trees depth-first while retaining stable root and sibling order.
 *
 * Legacy roots omit `parentId`. Malformed missing-parent or cyclic entries are retained as
 * roots rather than disappearing; intent planning prevents new malformed relationships.
 */
export function selectThreadedStoredReviewNotes(
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): ReviewThreadedStoredNote[] {
  const entries = selectStoredReviewNotes(state);
  const byId = new Map(entries.map((entry) => [entry.note.id, entry] as const));
  const children = new Map<string, ReviewStoredNote[]>();
  const roots: ReviewStoredNote[] = [];

  for (const entry of entries) {
    const parentId = entry.note.parentId;
    if (!parentId || parentId === entry.note.id || !byId.has(parentId)) {
      roots.push(entry);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(entry);
    children.set(parentId, siblings);
  }

  const result: ReviewThreadedStoredNote[] = [];
  const visited = new Set<string>();
  const appendTree = (root: ReviewStoredNote, rootId: string) => {
    const pending = [{ entry: root, depth: 0 }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current.entry.note.id)) {
        continue;
      }
      visited.add(current.entry.note.id);
      result.push({
        entry: current.entry,
        rootId,
        depth: current.depth,
        ...(current.entry.note.parentId ? { parentId: current.entry.note.parentId } : {}),
      });
      const descendants = children.get(current.entry.note.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        pending.push({ entry: descendants[index]!, depth: current.depth + 1 });
      }
    }
  };

  for (const root of roots) {
    appendTree(root, root.note.id);
  }
  // A pre-existing cycle has no root. Retain its entries without recursing forever so an
  // authoritative export can still report and repair them.
  for (const entry of entries) {
    if (!visited.has(entry.note.id)) {
      appendTree(entry, entry.note.id);
    }
  }
  return result;
}

/** One renderable threaded note with depth and connector facts collapsed across hidden ancestors. */
export interface ReviewVisibleThreadedStoredNote extends ReviewThreadedStoredNote {
  visibleDepth: number;
  visibleParentId?: string;
  hasNextVisibleSibling: boolean;
  /** Whether each visible ancestor has another sibling after its subtree. */
  visibleAncestorHasNextSibling: readonly boolean[];
}

/** Apply shared resolution and agent-note visibility policies to one threaded stream. */
export function selectVisibleThreadedStoredReviewNotes(
  state: Pick<ReviewState, "liveNotes" | "showAgentNotes" | "userNotes">,
): ReviewVisibleThreadedStoredNote[] {
  const threaded = selectThreadedStoredReviewNotes(state);
  const nearestVisibleDepth = new Map<string, number>();
  const nearestVisibleId = new Map<string, string>();
  const visible: Array<
    ReviewThreadedStoredNote & { visibleDepth: number; visibleParentId?: string }
  > = [];

  for (const item of threaded) {
    const { entry } = item;
    const parentDepth = entry.note.parentId
      ? nearestVisibleDepth.get(entry.note.parentId)
      : undefined;
    const visibleParentId = entry.note.parentId
      ? nearestVisibleId.get(entry.note.parentId)
      : undefined;
    if (
      isRenderableStoredReviewNote(entry) &&
      reviewNoteVisibleByPolicy(entry.note, state.showAgentNotes)
    ) {
      const visibleDepth = parentDepth === undefined ? 0 : parentDepth + 1;
      nearestVisibleDepth.set(entry.note.id, visibleDepth);
      nearestVisibleId.set(entry.note.id, entry.note.id);
      visible.push({
        ...item,
        visibleDepth,
        ...(visibleParentId ? { visibleParentId } : {}),
      });
    } else if (parentDepth !== undefined && visibleParentId !== undefined) {
      nearestVisibleDepth.set(entry.note.id, parentDepth);
      nearestVisibleId.set(entry.note.id, visibleParentId);
    }
  }

  const hasNextVisibleSibling = visible.map((item, index) =>
    item.visibleParentId
      ? visible.slice(index + 1).some((candidate) => {
          if (candidate.visibleDepth < item.visibleDepth) {
            return false;
          }
          return candidate.visibleParentId === item.visibleParentId;
        })
      : false,
  );
  const decoratedById = new Map<string, ReviewVisibleThreadedStoredNote>();

  return visible.map((item, index) => {
    const parent = item.visibleParentId ? decoratedById.get(item.visibleParentId) : undefined;
    const decorated: ReviewVisibleThreadedStoredNote = {
      ...item,
      hasNextVisibleSibling: hasNextVisibleSibling[index] ?? false,
      visibleAncestorHasNextSibling: parent
        ? [...parent.visibleAncestorHasNextSibling, parent.hasNextVisibleSibling]
        : [],
    };
    decoratedById.set(item.entry.note.id, decorated);
    return decorated;
  });
}

/** Whether one note owns any direct or transitive replies. */
export function reviewNoteHasDescendants(
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
  noteId: string,
) {
  const children = new Map<string, string[]>();
  for (const { note } of selectStoredReviewNotes(state)) {
    if (!note.parentId) {
      continue;
    }
    const ids = children.get(note.parentId) ?? [];
    ids.push(note.id);
    children.set(note.parentId, ids);
  }
  const pending = [...(children.get(noteId) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const childId = pending.pop()!;
    if (visited.has(childId)) {
      continue;
    }
    visited.add(childId);
    if (childId !== noteId) {
      return true;
    }
    pending.push(...(children.get(childId) ?? []));
  }
  return false;
}

/** Every mutable note currently safe to render, in shared threaded order. */
function renderableNotes(state: Pick<ReviewState, "liveNotes" | "userNotes">): ReviewNoteV1[] {
  return selectThreadedStoredReviewNotes(state)
    .map(({ entry }) => entry)
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

/** One note a reveal could land on, described the way any surface can describe what it draws. */
export interface ReviewRevealNoteCandidate {
  id: string;
  /** The line the note hangs beside; "earliest in the hunk" compares these. */
  line: number;
  /** The reviewer's open draft, which outranks every settled note. */
  draft?: boolean;
}

/**
 * Picks the note a "jump to the note" reveal targets, among one hunk's notes.
 *
 * Named policy: an open draft wins, because the reviewer is writing it right now;
 * otherwise the note whose anchor sits earliest, with arrival order breaking ties.
 * Candidates arrive already scoped to the hunk being revealed, because *which* notes a
 * surface shows is that surface's own fact — the terminal draws sidecar annotations that
 * never entered the note store — while which of them wins is this one rule. Undefined
 * means the hunk has nothing to reveal and the caller should reveal the hunk itself.
 */
export function resolveReviewRevealNoteId(
  candidates: readonly ReviewRevealNoteCandidate[],
): string | undefined {
  const draft = candidates.find((candidate) => candidate.draft);
  if (draft) {
    return draft.id;
  }

  return candidates
    .map((candidate, arrival) => ({ candidate, arrival }))
    .sort(
      (left, right) => left.candidate.line - right.candidate.line || left.arrival - right.arrival,
    )[0]?.candidate.id;
}

/** Pick the first stored note in the selection that satisfies one card capability. */
function selectActiveStoredNoteId(
  state: Pick<ReviewState, "document" | "liveNotes" | "selection" | "showAgentNotes" | "userNotes">,
  accepts: (entry: ReviewStoredNote) => boolean,
): string | undefined {
  const { fileKey, hunkIndex } = state.selection;
  const file = selectReviewFileByKey(state, fileKey);
  if (!file) {
    return undefined;
  }
  return selectVisibleThreadedStoredReviewNotes(state)
    .map(({ entry }) => entry)
    .filter(
      (entry) =>
        isRenderableStoredReviewNote(entry) &&
        entry.note.fileKey === fileKey &&
        reviewNoteCurrentOwnerHunkIndex(entry.note, file) === hunkIndex &&
        accepts(entry),
    )
    .sort(
      (left, right) => reviewNoteAnchorLine(left.note).line - reviewNoteAnchorLine(right.note).line,
    )[0]?.note.id;
}

/** Editable reviewer note the keyboard acts on in the selected hunk. */
export function selectActiveEditableReviewNoteId(
  state: Pick<ReviewState, "document" | "liveNotes" | "selection" | "showAgentNotes" | "userNotes">,
) {
  return selectActiveStoredNoteId(state, ({ note }) => note.source === "user" && note.editable);
}

/** Replyable semantic note the keyboard acts on in the selected hunk. */
export function selectActiveReplyableReviewNoteId(
  state: Pick<ReviewState, "document" | "liveNotes" | "selection" | "showAgentNotes" | "userNotes">,
) {
  return selectActiveStoredNoteId(state, () => true);
}

/** Which note a "jump to the note" reveal targets among the notes the store holds. */
export function selectActiveRevealNoteId(
  state: Pick<ReviewState, "draftNote" | "liveNotes" | "selection" | "userNotes">,
): string | undefined {
  const { fileKey, hunkIndex } = state.selection;
  if (fileKey === null) {
    return undefined;
  }

  const draft = state.draftNote;
  return resolveReviewRevealNoteId([
    ...(draft && draft.fileKey === fileKey && draft.hunkIndex === hunkIndex
      ? [{ id: draft.id, line: draft.line, draft: true }]
      : []),
    ...renderableNotes(state)
      .filter((note) => note.fileKey === fileKey && reviewNoteOwnerHunkIndex(note) === hunkIndex)
      .map((note) => ({ id: note.id, line: reviewNoteAnchorLine(note).line })),
  ]);
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
