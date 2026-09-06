/**
 * Converts between the terminal's diff model and the shared review model.
 *
 * The store in `packages/hunk/src/core/review` addresses files by semantic key and notes by line
 * anchor; the terminal addresses files by runtime id and renders notes as annotations.
 * Every crossing between the two goes through this module, so no component re-derives
 * the mapping inline and no note loses a field on the way across.
 *
 * Projecting the document itself is `projectReviewDocument` in `core/review/document`, a
 * different operation entirely; what remains here is the terminal's own note and draft
 * shapes, which no other surface renders.
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
import type { ReviewThreadedStoredNote } from "../../core/review/selectors";
import type { ReviewNoteV1 } from "../../core/review/types";
import type { DiffFile } from "../../core/changeset/model";
import type { AgentAnnotation } from "../../extension-api/types";
import { reviewNoteSource } from "./agentAnnotations";

/** One reviewer-authored note as the terminal review stream renders it. */
export interface StoredReviewNoteRenderMetadata {
  reviewNoteId: string;
  parentId?: string;
  threadDepth: number;
  hasReplies?: boolean;
  hasNextSibling?: boolean;
  ancestorHasNextSibling?: readonly boolean[];
  semanticallyStored: true;
}

/** Compatibility shape accepted by older terminal-only test projections. */
type OptionalStoredReviewNoteRenderMetadata = Partial<StoredReviewNoteRenderMetadata>;

export interface UserReviewNote extends AgentAnnotation, OptionalStoredReviewNoteRenderMetadata {
  id: string;
  source: "user";
  filePath: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  summary: string;
  author: string;
  createdAt: string;
  editable: boolean;
}

/** One in-progress reviewer note, addressed the way the diff pane draws it. */
export interface DraftReviewNote {
  id: string;
  kind?: "create" | "edit" | "reply";
  targetNoteId?: string;
  parentId?: string;
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
export function storedNoteToLiveComment(
  note: ReviewNoteV1,
  filePath: string,
  threadDepth = 0,
  hasReplies = false,
  threadGuide?: Pick<StoredReviewNoteRenderMetadata, "ancestorHasNextSibling" | "hasNextSibling">,
): LiveComment & OptionalStoredReviewNoteRenderMetadata {
  const anchorLine = reviewNoteAnchorLine(note);
  return {
    id: note.id,
    reviewNoteId: note.id,
    ...(note.parentId ? { parentId: note.parentId } : {}),
    threadDepth,
    ...(hasReplies ? { hasReplies: true } : {}),
    ...threadGuide,
    semanticallyStored: true,
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
export function storedNoteToUserNote(
  note: ReviewNoteV1,
  filePath: string,
  threadDepth = 0,
  hasReplies = false,
  threadGuide?: Pick<StoredReviewNoteRenderMetadata, "ancestorHasNextSibling" | "hasNextSibling">,
): UserReviewNote {
  const anchorLine = reviewNoteAnchorLine(note);
  return {
    id: note.id,
    reviewNoteId: note.id,
    ...(note.parentId ? { parentId: note.parentId } : {}),
    threadDepth,
    ...(hasReplies ? { hasReplies: true } : {}),
    ...threadGuide,
    semanticallyStored: true,
    source: "user",
    filePath,
    hunkIndex: reviewNoteOwnerHunkIndex(note),
    side: anchorLine.side,
    line: anchorLine.line,
    author: note.author ?? "user",
    createdAt: note.createdAt ?? "1970-01-01T00:00:00.000Z",
    updatedAt: note.updatedAt,
    editable: note.editable,
    ...annotationFields(note),
  };
}

/** Render the semantic draft as the draft the diff pane places and edits. */
export function storedDraftToDraftNote(draft: ReviewDraftNote, file: DiffFile): DraftReviewNote {
  const anchor = reviewLineAnchor(file.metadata.hunks, draft);
  return {
    id: draft.id,
    kind: draft.kind ?? "create",
    ...(draft.kind === "edit" ? { targetNoteId: draft.targetNoteId } : {}),
    ...(draft.kind === "reply" ? { parentId: draft.parentId } : {}),
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

/** Group a shared threaded stream by terminal file id without losing derived depth. */
export function groupThreadedStoredNotesByFileId<T>(
  entries: readonly ReviewThreadedStoredNote[],
  fileByKey: ReadonlyMap<string, DiffFile>,
  project: (
    note: ReviewNoteV1,
    filePath: string,
    depth: number,
    hasReplies: boolean,
    threadGuide: Pick<StoredReviewNoteRenderMetadata, "ancestorHasNextSibling" | "hasNextSibling">,
  ) => T,
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const [index, item] of entries.entries()) {
    const { entry, depth } = item;
    const renderDepth = "visibleDepth" in item ? (item.visibleDepth as number) : depth;
    const file = fileByKey.get(entry.note.fileKey);
    if (!file || !isRenderableStoredReviewNote(entry)) {
      continue;
    }
    const hasReplies = (entries[index + 1]?.depth ?? -1) > depth;
    const threadGuide = {
      hasNextSibling: "hasNextVisibleSibling" in item ? Boolean(item.hasNextVisibleSibling) : false,
      ancestorHasNextSibling:
        "visibleAncestorHasNextSibling" in item && Array.isArray(item.visibleAncestorHasNextSibling)
          ? item.visibleAncestorHasNextSibling
          : [],
    };
    (result[file.id] ??= []).push(
      project(entry.note, file.path, renderDepth, hasReplies, threadGuide),
    );
  }
  return result;
}
