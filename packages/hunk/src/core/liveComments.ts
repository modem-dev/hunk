import type { AgentAnnotation } from "../extension-api/types";
import type { DiffFile } from "./changeset/model";
import { reviewDefaultHunkLineTarget, reviewHunkIndexForLine } from "./review/geometry";

export type DiffSide = "old" | "new";

/**
 * The one diff line a user note hangs on: which side of the hunk, and the line
 * number on that side. Surfaces resolve a click or cursor position into this
 * before asking for a note, so the note's anchor never depends on rendered rows.
 */
export interface UserNoteLineTarget {
  side: DiffSide;
  line: number;
}

export interface CommentTargetInput {
  filePath: string;
  hunkIndex?: number;
  side?: DiffSide;
  line?: number;
  summary: string;
  rationale?: string;
  /** Optional STML markup rendered as the note body (see packages/hunk/src/ui/lib/stml). */
  markup?: string;
  author?: string;
}

export interface LiveComment extends AgentAnnotation {
  id: string;
  source: "mcp";
  author?: string;
  createdAt: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
}

export interface ResolvedCommentTarget {
  hunkIndex: number;
  side: DiffSide;
  line: number;
}

/** Find the diff file matching one current or previous path. */
export function findDiffFileByPath(files: DiffFile[], filePath: string) {
  return files.find((file) => file.path === filePath || file.previousPath === filePath);
}

/** Find the first hunk covering one requested side/line location. */
export function findHunkIndexForLine(file: DiffFile, side: DiffSide, line: number) {
  return reviewHunkIndexForLine(file.metadata.hunks, side, line);
}

/** Resolve either a hunk-wide or line-specific target against one visible diff file. */
export function resolveCommentTarget(
  file: DiffFile,
  input: CommentTargetInput,
): ResolvedCommentTarget {
  if (input.hunkIndex !== undefined) {
    const hunk = file.metadata.hunks[input.hunkIndex];
    if (!hunk) {
      throw new Error(`No diff hunk ${input.hunkIndex + 1} exists in ${input.filePath}.`);
    }

    return {
      hunkIndex: input.hunkIndex,
      ...reviewDefaultHunkLineTarget(hunk),
    };
  }

  if (input.side === undefined || input.line === undefined) {
    throw new Error(`Specify either hunkIndex or both side and line for ${input.filePath}.`);
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

/** Convert one incoming session-daemon comment command into a live annotation. */
export function buildLiveComment(
  input: CommentTargetInput & { side: DiffSide; line: number },
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
    markup: input.markup,
    oldRange: input.side === "old" ? [input.line, input.line] : undefined,
    newRange: input.side === "new" ? [input.line, input.line] : undefined,
    tags: ["mcp"],
    confidence: "high",
  };
}
