/**
 * The terminal's projection of the shared review model.
 *
 * The store in `src/core/review` addresses files by semantic key and notes by line
 * anchor; the terminal addresses files by runtime id and renders notes as annotations.
 * This module is the one boundary where the two meet, so no component re-derives the
 * mapping inline and no note loses a field on the way across.
 *
 * Projection of the document itself lives in `core/review/document`; what remains here is
 * the terminal's own note and draft shapes, which no other surface renders.
 */
import type { LiveComment } from "../../core/liveComments";
import { reviewLineAnchor } from "../../core/review/anchors";
import type { ReviewHunkSpan } from "../../core/review/geometry";
import {
  isRenderableStoredReviewNote,
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  type ReviewDraftNote,
  type ReviewStoredNote,
} from "../../core/review/state";
import type { ReviewNoteV1 } from "../../core/review/types";
import type { AgentAnnotation, DiffFile } from "../../core/types";
import { reviewNoteSource } from "./agentAnnotations";

/** One reviewer-authored note as the terminal review stream renders it. */
export interface UserReviewNote extends AgentAnnotation {
  id: string;
  source: "user";
  filePath: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  summary: string;
  author: string;
  createdAt: string;
  editable: true;
}

/** One in-progress reviewer note, addressed the way the diff pane draws it. */
export interface DraftReviewNote {
  id: string;
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  oldRange?: [number, number];
  newRange?: [number, number];
  body: string;
}

/** Carry the annotation fields both note models share, in the terminal's shape. */
function annotationFields(note: ReviewNoteV1) {
  return {
    oldRange: note.anchor.oldRange ? ([...note.anchor.oldRange] as [number, number]) : undefined,
    newRange: note.anchor.newRange ? ([...note.anchor.newRange] as [number, number]) : undefined,
    summary: note.summary,
    rationale: note.rationale,
    markup: note.markup,
    title: note.title,
    tags: note.tags,
    confidence: note.confidence,
  };
}

/** Store one agent-authored live comment as a semantic review note. */
export function liveCommentToStoredNote(
  comment: LiveComment,
  fileKey: string,
  hunks: readonly ReviewHunkSpan[],
): ReviewStoredNote {
  return {
    note: {
      id: comment.id,
      source: reviewNoteSource(comment),
      originalSource: comment.source,
      fileKey,
      anchor: reviewLineAnchor(hunks, comment),
      summary: comment.summary,
      rationale: comment.rationale,
      markup: comment.markup,
      title: comment.title,
      author: comment.author,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      editable: false,
      tags: comment.tags,
      confidence: comment.confidence,
    },
    resolution: "active",
  };
}

/** Render one semantic note back as the live comment the terminal review stream draws. */
export function storedNoteToLiveComment(note: ReviewNoteV1, filePath: string): LiveComment {
  const anchorLine = reviewNoteAnchorLine(note);
  return {
    id: note.id,
    source: "mcp",
    author: note.author,
    createdAt: note.createdAt ?? "1970-01-01T00:00:00.000Z",
    updatedAt: note.updatedAt,
    filePath,
    hunkIndex: reviewNoteOwnerHunkIndex(note),
    side: anchorLine.side,
    line: anchorLine.line,
    ...annotationFields(note),
  };
}

/** Render one semantic note back as the reviewer-authored note the terminal shows. */
export function storedNoteToUserNote(note: ReviewNoteV1, filePath: string): UserReviewNote {
  const anchorLine = reviewNoteAnchorLine(note);
  return {
    id: note.id,
    source: "user",
    filePath,
    hunkIndex: reviewNoteOwnerHunkIndex(note),
    side: anchorLine.side,
    line: anchorLine.line,
    author: note.author ?? "user",
    createdAt: note.createdAt ?? "1970-01-01T00:00:00.000Z",
    updatedAt: note.updatedAt,
    editable: true,
    ...annotationFields(note),
  };
}

/** Render the semantic draft as the draft the diff pane places and edits. */
export function storedDraftToDraftNote(draft: ReviewDraftNote, file: DiffFile): DraftReviewNote {
  const anchor = reviewLineAnchor(file.metadata.hunks, draft);
  return {
    id: draft.id,
    fileId: file.id,
    filePath: file.path,
    hunkIndex: draft.hunkIndex,
    side: draft.side,
    line: draft.line,
    oldRange: anchor.oldRange ? ([...anchor.oldRange] as [number, number]) : undefined,
    newRange: anchor.newRange ? ([...anchor.newRange] as [number, number]) : undefined,
    body: draft.body,
  };
}

/**
 * Group renderable stored notes by terminal file id, preserving stored order.
 *
 * Notes whose file left the review are dropped rather than rendered against a stale
 * path; the store keeps them so a reload that brings the file back restores them too.
 */
export function groupStoredNotesByFileId<T>(
  entries: readonly ReviewStoredNote[],
  fileByKey: ReadonlyMap<string, DiffFile>,
  project: (note: ReviewNoteV1, filePath: string) => T,
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const entry of entries) {
    const file = fileByKey.get(entry.note.fileKey);
    if (!file || !isRenderableStoredReviewNote(entry)) {
      continue;
    }
    (result[file.id] ??= []).push(project(entry.note, file.path));
  }
  return result;
}
