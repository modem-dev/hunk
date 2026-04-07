import type { Hunk } from "@pierre/diffs";

/** Format a unified-diff hunk header exactly as Hunk should display it. */
export function formatHunkHeader(hunk: Hunk) {
  const specs =
    hunk.hunkSpecs ??
    `@@ -${hunk.deletionStart},${hunk.deletionLines} +${hunk.additionStart},${hunk.additionLines} @@`;
  return hunk.hunkContext ? `${specs} ${hunk.hunkContext}` : specs;
}
