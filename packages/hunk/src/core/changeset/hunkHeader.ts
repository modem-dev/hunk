import type { ReviewHunkSpan } from "../review/geometry";

/**
 * The facts a hunk header is built from.
 *
 * Structural rather than the parser's own type, so a parsed hunk and a projected semantic
 * hunk both satisfy it and the header can never depend on which model a caller holds.
 */
export interface ReviewHunkHeaderSource extends ReviewHunkSpan {
  hunkSpecs?: string | null;
  hunkContext?: string | null;
}

/** Format a unified-diff hunk header exactly as Hunk should display it. */
export function formatHunkHeader(hunk: ReviewHunkHeaderSource) {
  const specs =
    hunk.hunkSpecs ??
    // The header count is the per-side line total (context + changes), i.e.
    // `*Count` parsed from `-X,count` / `+X,count` — not `*Lines`, which is
    // only the changed `+`/`-` lines and would undercount a context-bearing hunk.
    `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`;
  return hunk.hunkContext ? `${specs} ${hunk.hunkContext}` : specs;
}
