import type { Hunk } from "@pierre/diffs";
import type { DiffFile } from "./types";
import type { CommentToolInput, DiffSide, LiveComment } from "../mcp/types";

export interface ResolvedCommentTarget {
  hunkIndex: number;
  side: DiffSide;
  line: number;
}

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

/** Pick one stable anchor line inside a hunk, preferring new-side changes when present. */
export function firstCommentTargetForHunk(hunk: Hunk): Omit<ResolvedCommentTarget, "hunkIndex"> {
  let deletionLineNumber = hunk.deletionStart;
  let additionLineNumber = hunk.additionStart;
  let firstDeletionLine: number | undefined;

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      deletionLineNumber += content.lines;
      additionLineNumber += content.lines;
      continue;
    }

    if (content.additions > 0) {
      return {
        side: "new",
        line: additionLineNumber,
      };
    }

    if (content.deletions > 0 && firstDeletionLine === undefined) {
      firstDeletionLine = deletionLineNumber;
    }

    deletionLineNumber += content.deletions;
    additionLineNumber += content.additions;
  }

  if (firstDeletionLine !== undefined) {
    return {
      side: "old",
      line: firstDeletionLine,
    };
  }

  const fallbackRange = hunkLineRange(hunk);
  return hunk.additionLines > 0
    ? { side: "new", line: fallbackRange.newRange[0] }
    : { side: "old", line: fallbackRange.oldRange[0] };
}

/** Resolve a line-based or hunk-based live-comment target against one visible diff file. */
export function resolveCommentTarget(
  file: DiffFile,
  input: CommentToolInput,
): ResolvedCommentTarget {
  if (input.hunkIndex !== undefined) {
    const hunk = file.metadata.hunks[input.hunkIndex];
    if (!hunk) {
      throw new Error(`No diff hunk ${input.hunkIndex + 1} exists in ${input.filePath}.`);
    }

    return {
      hunkIndex: input.hunkIndex,
      ...firstCommentTargetForHunk(hunk),
    };
  }

  if (!input.side || input.line === undefined) {
    throw new Error("comment requires either hunkIndex or both side and line.");
  }

  const hunkIndex = findHunkIndexForLine(file, input.side, input.line);
  if (hunkIndex < 0) {
    throw new Error(`No ${input.side} diff hunk in ${input.filePath} covers line ${input.line}.`);
  }

  return {
    hunkIndex,
    side: input.side,
    line: input.line,
  };
}

/** Convert one incoming MCP comment command into a live annotation. */
export function buildLiveComment(
  input: CommentToolInput & { side: DiffSide; line: number },
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
