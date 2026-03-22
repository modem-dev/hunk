import type { Hunk } from "@pierre/diffs";
import type { DiffFile } from "./types";
import type { CommentToolInput, DiffSide, LiveComment } from "../mcp/types";

/** Compute the inclusive old/new line spans touched by one hunk. */
export function hunkLineRange(hunk: Hunk) {
  const newEnd = Math.max(
    hunk.additionStart,
    hunk.additionStart + Math.max(hunk.additionLines, 1) - 1,
  );
  const oldEnd = Math.max(
    hunk.deletionStart,
    hunk.deletionStart + Math.max(hunk.deletionLines, 1) - 1,
  );

  return {
    oldRange: [hunk.deletionStart, oldEnd] as [number, number],
    newRange: [hunk.additionStart, newEnd] as [number, number],
  };
}

/** Find the diff file matching one current or previous path. */
export function findDiffFileByPath(files: DiffFile[], filePath: string) {
  return files.find((file) => file.path === filePath || file.previousPath === filePath);
}

/** Find the first hunk covering one requested side/line location. */
export function findHunkIndexForLine(file: DiffFile, side: DiffSide, line: number) {
  return file.metadata.hunks.findIndex((hunk) => {
    const range = hunkLineRange(hunk);
    const target = side === "new" ? range.newRange : range.oldRange;
    return line >= target[0] && line <= target[1];
  });
}

/** Convert one incoming MCP comment command into a live annotation. */
export function buildLiveComment(
  input: CommentToolInput,
  commentId: string,
  createdAt: string,
  hunkIndex: number,
): LiveComment {
  return {
    id: commentId,
    source: "mcp",
    author: input.author,
    createdAt,
    filePath: input.filePath,
    hunkIndex,
    side: input.side,
    line: input.line,
    summary: input.summary,
    rationale: input.rationale,
    oldRange: input.side === "old" ? [input.line, input.line] : undefined,
    newRange: input.side === "new" ? [input.line, input.line] : undefined,
    tags: ["mcp"],
    confidence: "high",
  };
}
