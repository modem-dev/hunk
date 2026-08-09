import type { Hunk } from "@pierre/diffs";

/** Format a unified-diff hunk header exactly as Hunk should display it. */
export function formatHunkHeader(hunk: Hunk) {
  const specs =
    hunk.hunkSpecs ??
    // The header count is the per-side line total (context + changes), i.e.
    // `*Count` parsed from `-X,count` / `+X,count` — not `*Lines`, which is
    // only the changed `+`/`-` lines and would undercount a context-bearing hunk.
    `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`;
  return hunk.hunkContext ? `${specs} ${hunk.hunkContext}` : specs;
}
