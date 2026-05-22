/** Build the stable DOM-like id used for sidebar file rows. */
export function fileRowId(fileId: string) {
  return `file-row:${fileId}`;
}

/** Build the stable id for a file section in the main review stream. */
export function diffSectionId(fileId: string) {
  return `diff-section:${fileId}`;
}

/** Build the stable id for a hunk anchor in the main review stream. */
export function diffHunkId(fileId: string, hunkIndex: number) {
  return `diff-hunk:${fileId}:${hunkIndex}`;
}

/** Build the stable id for one presentational review row in the main diff stream. */
export function reviewRowId(rowKey: string) {
  return `review-row:${rowKey}`;
}

/**
 * Constant id placed on the diff row currently under the comment cursor.
 *
 * There is only ever one cursor row in the review stream at a time, so we can use a single fixed
 * id and have the scroll engine target it directly via scrollChildIntoView.
 */
export const COMMENT_CURSOR_ANCHOR_ID = "comment-cursor-anchor";
