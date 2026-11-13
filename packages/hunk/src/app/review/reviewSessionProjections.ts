/**
 * Projects one live review's semantic state onto the shapes agents and the session export read.
 *
 * `ReviewSessionHost` answers `hunk session` commands and publishes the daemon snapshot from
 * these projections, and the terminal review hook memoizes the same functions over its
 * render-time inputs, so a headless host and a mounted terminal report one answer for the
 * same review. Every function here is pure: it reads diff files, the projected document, and
 * a `ReviewState`, and owns no lifetime of its own.
 *
 * Runtime file ids are the session vocabulary (`fileId` in every agent reply); semantic file
 * keys are the store's. The file index below is the one crossing between the two.
 */
import { findDiffFileByPath, findHunkIndexForLine } from "../../core/liveComments";
import {
  buildReviewAnnotationIndex,
  reviewNoteSource,
  type ReviewAnnotationTarget,
} from "../../core/review/annotations";
import { reviewHunkRanges } from "../../core/review/geometry";
import type { ReviewAnnotationIndex } from "../../core/review/navigation";
import type { ReviewAction } from "../../core/review/actions";
import {
  selectNormalizedSelection,
  selectThreadedStoredReviewNotes,
} from "../../core/review/selectors";
import {
  isRenderableStoredReviewNote,
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  type ReviewState,
} from "../../core/review/state";
import type { ReviewDocumentV1, ReviewNoteV1 } from "../../core/review/types";
import type { DiffFile } from "../../core/changeset/model";
import type { AgentAnnotation } from "../../extension-api/types";
import { noDiffFileMatchesMessage } from "../../session/agent/errors";
import type {
  HunkSessionState,
  NavigateToHunkToolInput,
  SelectedHunkSummary,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../../session/types";

/** Placeholder creation time for notes that never recorded one. */
const UNKNOWN_NOTE_CREATED_AT = "1970-01-01T00:00:00.000Z";

/** Lookups between runtime file ids and the semantic file keys of one projected document. */
export interface ReviewFileIndex {
  keyByFileId: ReadonlyMap<string, string>;
  fileByKey: ReadonlyMap<string, DiffFile>;
}

export interface ReviewNavigationTarget {
  file: DiffFile;
  hunkIndex: number;
}

/** Index one document's files by runtime id and by semantic key. */
export function indexReviewFiles(
  document: ReviewDocumentV1,
  files: readonly DiffFile[],
): ReviewFileIndex {
  const byRuntimeId = new Map(files.map((file) => [file.id, file] as const));
  return {
    keyByFileId: new Map(document.files.map((file) => [file.runtimeId, file.key] as const)),
    fileByKey: new Map(
      document.files.flatMap((semantic) => {
        const file = byRuntimeId.get(semantic.runtimeId);
        return file ? [[semantic.key, file] as const] : [];
      }),
    ),
  };
}

/** Copy one note's anchor ranges in the annotation shape diff files carry. */
function noteRanges(note: ReviewNoteV1) {
  return {
    oldRange: note.anchor.oldRange ? ([...note.anchor.oldRange] as [number, number]) : undefined,
    newRange: note.anchor.newRange ? ([...note.anchor.newRange] as [number, number]) : undefined,
  };
}

/** Join a note's summary and rationale the way session summaries report a body. */
function noteBody(note: { summary: string; rationale?: string }) {
  return [note.summary, note.rationale].filter(Boolean).join("\n\n");
}

/**
 * Index which files and hunks the review's notes reach, for annotated navigation.
 *
 * Sidecar annotations and every renderable stored note count, merged onto their files the
 * way the review stream draws them, so a live comment that just arrived is navigable at once.
 * Stored notes declare their owner hunk and line, as drawing places them; sidecar
 * annotations resolve from geometry alone.
 */
export function buildReviewSessionAnnotationIndex(
  files: readonly DiffFile[],
  fileIndex: ReviewFileIndex,
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): ReviewAnnotationIndex {
  const targets = new Map<AgentAnnotation, ReviewAnnotationTarget>();
  const storedByFileId = new Map<string, AgentAnnotation[]>();
  for (const { entry } of selectThreadedStoredReviewNotes(state)) {
    const file = fileIndex.fileByKey.get(entry.note.fileKey);
    if (!file || !isRenderableStoredReviewNote(entry)) {
      continue;
    }

    const annotation: AgentAnnotation = { ...noteRanges(entry.note), summary: entry.note.summary };
    targets.set(annotation, {
      hunkIndex: reviewNoteOwnerHunkIndex(entry.note),
      ...reviewNoteAnchorLine(entry.note),
    });
    const stored = storedByFileId.get(file.id) ?? [];
    stored.push(annotation);
    storedByFileId.set(file.id, stored);
  }

  const merged = files.map((file) => {
    const stored = storedByFileId.get(file.id);
    return stored
      ? {
          ...file,
          agent: {
            path: file.path,
            summary: file.agent?.summary,
            annotations: [...(file.agent?.annotations ?? []), ...stored],
          },
        }
      : file;
  });
  return buildReviewAnnotationIndex(merged, fileIndex.keyByFileId, (annotation) =>
    targets.get(annotation),
  );
}

/**
 * List the review's agent live comments for daemon snapshots, in file order then arrival order.
 *
 * Notes on files a reload retired stay in the store and are left out here, so the published
 * count always matches the list.
 */
export function buildLiveCommentSummaries(
  files: readonly DiffFile[],
  fileIndex: ReviewFileIndex,
  state: Pick<ReviewState, "liveNotes">,
): SessionLiveCommentSummary[] {
  const notesByFileId = new Map<string, ReviewNoteV1[]>();
  for (const entry of state.liveNotes) {
    const file = fileIndex.fileByKey.get(entry.note.fileKey);
    if (!file || !isRenderableStoredReviewNote(entry)) {
      continue;
    }
    const notes = notesByFileId.get(file.id) ?? [];
    notes.push(entry.note);
    notesByFileId.set(file.id, notes);
  }

  return files.flatMap((file) =>
    (notesByFileId.get(file.id) ?? []).map((note) => {
      const anchorLine = reviewNoteAnchorLine(note);
      return {
        commentId: note.id,
        ...(note.parentId ? { parentId: note.parentId } : {}),
        filePath: file.path,
        hunkIndex: reviewNoteOwnerHunkIndex(note),
        side: anchorLine.side,
        line: anchorLine.line,
        summary: note.summary,
        rationale: note.rationale,
        author: note.author,
        createdAt: note.createdAt ?? UNKNOWN_NOTE_CREATED_AT,
      };
    }),
  );
}

/**
 * List every inline note for daemon snapshots: per file, sidecar annotations and then stored
 * notes in thread order.
 */
export function buildReviewNoteSummaries(
  files: readonly DiffFile[],
  fileIndex: ReviewFileIndex,
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): SessionReviewNoteSummary[] {
  const storedByFileId = new Map<string, ReviewNoteV1[]>();
  for (const { entry } of selectThreadedStoredReviewNotes(state)) {
    const file = fileIndex.fileByKey.get(entry.note.fileKey);
    if (!file || !isRenderableStoredReviewNote(entry)) {
      continue;
    }
    const notes = storedByFileId.get(file.id) ?? [];
    notes.push(entry.note);
    storedByFileId.set(file.id, notes);
  }

  const noteSummaries: SessionReviewNoteSummary[] = [];
  for (const file of files) {
    (file.agent?.annotations ?? []).forEach((annotation, index) => {
      const source = reviewNoteSource(annotation);
      noteSummaries.push({
        noteId: annotation.id ?? `${source}:${file.id}:${index}`,
        source,
        filePath: file.path,
        oldRange: annotation.oldRange,
        newRange: annotation.newRange,
        body: noteBody(annotation),
        title: annotation.title,
        author: annotation.author,
        createdAt: annotation.createdAt ?? UNKNOWN_NOTE_CREATED_AT,
        updatedAt: annotation.updatedAt,
        editable: false,
      });
    });

    for (const note of storedByFileId.get(file.id) ?? []) {
      // Stored notes are either the reviewer's own or agent-authored live comments.
      const source = note.source === "user" ? "user" : "agent";
      const ranges = noteRanges(note);
      noteSummaries.push({
        noteId: note.id,
        ...(note.parentId ? { parentId: note.parentId } : {}),
        source,
        filePath: file.path,
        hunkIndex: reviewNoteOwnerHunkIndex(note),
        oldRange: ranges.oldRange,
        newRange: ranges.newRange,
        body: noteBody(note),
        author: source === "user" ? (note.author ?? "user") : note.author,
        createdAt: note.createdAt ?? UNKNOWN_NOTE_CREATED_AT,
        updatedAt: note.updatedAt,
        editable: source === "user",
      });
    }
  }

  return noteSummaries;
}

/**
 * Plan the follow-up when a document replacement invalidates the stored selection.
 *
 * A filter only changes the visible stream, so a selected file it hides stays selected. The
 * shared selector supplies a replacement only when the selected file vanished or its hunk index
 * became stale. This returns no reveal request: repair must not move a viewport.
 */
export function planReviewSelectionRepair(
  state: ReviewState,
): Extract<ReviewAction, { type: "selection/select" }> | undefined {
  const normalized = selectNormalizedSelection(state);
  const fileKey = normalized.fileKey;
  if (
    fileKey === null ||
    (fileKey === state.selection.fileKey && normalized.hunkIndex === state.selection.hunkIndex)
  ) {
    return undefined;
  }

  return { type: "selection/select", fileKey, hunkIndex: normalized.hunkIndex };
}

/** Format the currently selected hunk for daemon snapshots and session command replies. */
export function buildSelectedHunkSummary(file: DiffFile, hunkIndex: number): SelectedHunkSummary {
  const hunk = file.metadata.hunks[hunkIndex];
  return hunk
    ? {
        index: hunkIndex,
        ...reviewHunkRanges(hunk),
      }
    : {
        index: hunkIndex,
      };
}

/**
 * Resolve one absolute session-daemon navigation request against the review stream.
 *
 * Absolute only — a path plus either a hunk index or a side and line. Relative requests
 * (`--next-comment` / `--prev-comment`) are the same walk the keyboard performs and are
 * planned through the shared `selection/move` intent instead of being resolved here.
 */
export function resolveReviewNavigationTarget({
  allFiles,
  input,
}: {
  allFiles: DiffFile[];
  input: NavigateToHunkToolInput;
}): ReviewNavigationTarget {
  if (!input.filePath) {
    throw new Error("navigate requires --file when not using --next-comment or --prev-comment.");
  }

  const file = findDiffFileByPath(allFiles, input.filePath);
  if (!file) {
    throw new Error(noDiffFileMatchesMessage(input.filePath));
  }

  let hunkIndex = input.hunkIndex;
  if (hunkIndex === undefined) {
    if (!input.side || input.line === undefined) {
      throw new Error("navigate_to_hunk requires either hunkIndex or both side and line.");
    }

    hunkIndex = findHunkIndexForLine(file, input.side, input.line);
  }

  if (hunkIndex < 0 || hunkIndex >= file.metadata.hunks.length) {
    throw new Error(`No diff hunk in ${input.filePath} matches the requested target.`);
  }

  return { file, hunkIndex };
}

/** Facts one session snapshot reports beside the review's own state. */
export interface SessionSnapshotStateInput {
  selectedFile: Pick<DiffFile, "id" | "path"> | undefined;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  selectedHunkIndex: number;
  showAgentNotes: boolean;
  /** Width STML note markup renders at, when a renderer measured one. */
  noteMarkupWidth?: number;
  liveCommentCount: number;
  liveComments: SessionLiveCommentSummary[];
  reviewNoteCount: number;
  reviewNotes: SessionReviewNoteSummary[];
  /** The producer generation being served, when one is published. */
  publicationGeneration?: string;
  stateRevision: number;
  /** The shared-state revision at this position, when the producer serves shared state. */
  sharedStateRevision?: number;
}

/**
 * Build the live state one session snapshot publishes to the daemon.
 *
 * Callers count from the summary lists they pass: the daemon refuses a snapshot whose count
 * differs from its list.
 */
export function buildSessionSnapshotState(input: SessionSnapshotStateInput): HunkSessionState {
  const selectedRange = input.selectedHunk ? reviewHunkRanges(input.selectedHunk) : undefined;
  return {
    selectedFileId: input.selectedFile?.id,
    selectedFilePath: input.selectedFile?.path,
    selectedHunkIndex: input.selectedHunkIndex,
    selectedHunkOldRange: selectedRange?.oldRange,
    selectedHunkNewRange: selectedRange?.newRange,
    showAgentNotes: input.showAgentNotes,
    noteMarkupWidth: input.noteMarkupWidth,
    liveCommentCount: input.liveCommentCount,
    liveComments: input.liveComments,
    reviewNoteCount: input.reviewNoteCount,
    reviewNotes: input.reviewNotes,
    // Where this review currently is, so the daemon's mirror can order what it receives
    // instead of guessing whether a snapshot is newer than the last.
    ...(input.publicationGeneration
      ? {
          reviewPublication: {
            generation: input.publicationGeneration,
            stateRevision: input.stateRevision,
          },
          ...(input.sharedStateRevision !== undefined
            ? { reviewSharedStateRevision: input.sharedStateRevision }
            : {}),
        }
      : {}),
  };
}
