import type { Hunk } from "@pierre/diffs";
import type { DiffFile } from "../../core/types";
import { firstCommentTargetForHunk } from "../../core/liveComments";
import type { DiffSide } from "../../hunk-session/types";
import type { DiffRow } from "../diff/pierre";

export interface CommentCursorPosition {
  fileId: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
}

/** Return the cursor anchor for one hunk — first addition, then deletion, then context. */
export function firstCursorTargetForHunk(
  file: DiffFile,
  hunkIndex: number,
): { side: DiffSide; line: number } {
  const hunk = file.metadata.hunks[hunkIndex];
  if (!hunk) {
    return { side: "new", line: 1 };
  }

  return firstCommentTargetForHunk(hunk);
}

/** Build the file-scoped stable row key used by reviewRenderPlan for a cursor position. */
export function cursorRowStableKey(cursor: CommentCursorPosition): string {
  return `line:${cursor.hunkIndex}:${cursor.side}:${cursor.line}`;
}

/**
 * Resolve the cursor target for a click on one diff row.
 *
 * Mirrors the changed-lines-only policy that {@link moveCursor} walks: clicks on
 * additions land on the new side, clicks on deletions land on the old side, and
 * clicks on context / hunk header / empty cells are not commentable so we return null.
 */
export function clickTargetForDiffRow(
  row: DiffRow,
): { hunkIndex: number; side: DiffSide; line: number } | null {
  if (row.type === "split-line") {
    if (row.right.kind === "addition" && row.right.lineNumber !== undefined) {
      return { hunkIndex: row.hunkIndex, side: "new", line: row.right.lineNumber };
    }

    if (row.left.kind === "deletion" && row.left.lineNumber !== undefined) {
      return { hunkIndex: row.hunkIndex, side: "old", line: row.left.lineNumber };
    }

    return null;
  }

  if (row.type === "stack-line") {
    if (row.cell.kind === "addition" && row.cell.newLineNumber !== undefined) {
      return { hunkIndex: row.hunkIndex, side: "new", line: row.cell.newLineNumber };
    }

    if (row.cell.kind === "deletion" && row.cell.oldLineNumber !== undefined) {
      return { hunkIndex: row.hunkIndex, side: "old", line: row.cell.oldLineNumber };
    }

    return null;
  }

  return null;
}

/**
 * Walk through every changed (non-context) line of a hunk on the cursor's anchor side.
 *
 * Skips context lines so that the cursor positions list aligns with the first
 * changed line returned by firstCursorTargetForHunk, allowing backward clamping
 * to reach the same anchor position.
 */
function* walkHunkLines(hunk: Hunk, side: DiffSide): Generator<{ side: DiffSide; line: number }> {
  let oldLine = hunk.deletionStart;
  let newLine = hunk.additionStart;

  for (const segment of hunk.hunkContent) {
    if (segment.type === "context") {
      // Advance both counters but do not yield cursor positions for context lines.
      oldLine += segment.lines;
      newLine += segment.lines;
      continue;
    }

    // Yield each changed line on the requested side.
    if (side === "new") {
      for (let offset = 0; offset < segment.additions; offset += 1) {
        yield { side: "new", line: newLine + offset };
      }
    } else {
      for (let offset = 0; offset < segment.deletions; offset += 1) {
        yield { side: "old", line: oldLine + offset };
      }
    }

    oldLine += segment.deletions;
    newLine += segment.additions;
  }
}

/** Build the ordered list of cursor positions for the full review stream on the cursor's side. */
function buildCursorPositions(files: DiffFile[], preferredSide: DiffSide): CommentCursorPosition[] {
  const positions: CommentCursorPosition[] = [];

  for (const file of files) {
    file.metadata.hunks.forEach((hunk, hunkIndex) => {
      for (const step of walkHunkLines(hunk, preferredSide)) {
        positions.push({
          fileId: file.id,
          hunkIndex,
          side: step.side,
          line: step.line,
        });
      }
    });
  }

  return positions;
}

/** Move the cursor forward or backward through the review stream by one row. */
export function moveCursor(
  files: DiffFile[],
  current: CommentCursorPosition,
  delta: number,
): CommentCursorPosition | null {
  const positions = buildCursorPositions(files, current.side);
  if (positions.length === 0) {
    return null;
  }

  const index = positions.findIndex(
    (position) =>
      position.fileId === current.fileId &&
      position.hunkIndex === current.hunkIndex &&
      position.line === current.line,
  );

  if (index < 0) {
    return delta >= 0 ? positions[0]! : positions[positions.length - 1]!;
  }

  const nextIndex = Math.max(0, Math.min(positions.length - 1, index + delta));
  return positions[nextIndex]!;
}
