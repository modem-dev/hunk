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
