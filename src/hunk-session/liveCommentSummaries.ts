import { findDiffFileByPath, type LiveComment } from "../core/liveComments";
import type { DiffFile } from "../core/types";
import type { SessionLiveCommentSummary } from "./types";

/** Convert a live annotation into the broker snapshot's compact summary shape. */
export function summarizeLiveComment(
  filePath: string,
  comment: LiveComment,
): SessionLiveCommentSummary {
  return {
    commentId: comment.id,
    filePath,
    hunkIndex: comment.hunkIndex,
    side: comment.side,
    line: comment.line,
    summary: comment.summary,
    rationale: comment.rationale,
    author: comment.author,
    createdAt: comment.createdAt,
  };
}

/** Rehydrate one broker snapshot comment into a live annotation. */
function liveCommentFromSummary(summary: SessionLiveCommentSummary): LiveComment {
  return {
    id: summary.commentId,
    source: "mcp",
    filePath: summary.filePath,
    hunkIndex: summary.hunkIndex,
    side: summary.side,
    line: summary.line,
    summary: summary.summary,
    rationale: summary.rationale,
    author: summary.author,
    createdAt: summary.createdAt,
    oldRange: summary.side === "old" ? [summary.line, summary.line] : undefined,
    newRange: summary.side === "new" ? [summary.line, summary.line] : undefined,
    tags: ["mcp"],
    confidence: "high",
  };
}

/** Rehydrate broker snapshot comments into a file-id keyed annotation map. */
export function liveCommentsByFileFromSummaries(
  files: DiffFile[],
  summaries: SessionLiveCommentSummary[] = [],
) {
  const byFileId: Record<string, LiveComment[]> = {};
  summaries.forEach((summary) => {
    const file = findDiffFileByPath(files, summary.filePath);
    if (!file) return;
    byFileId[file.id] = [...(byFileId[file.id] ?? []), liveCommentFromSummary(summary)];
  });
  return byFileId;
}
