import type { ExtensionDiffHunk } from "../../extension-api/types";
import { formatHunkHeader, type ReviewHunkHeaderSource } from "./hunkHeader";
import { reviewHunkRanges } from "../review/geometry";

/** Report whether one hunk carries the numeric header fields ranges derive from. */
function hasLineNumbers(hunk: ReviewHunkHeaderSource) {
  return (
    Number.isFinite(hunk.additionStart) &&
    Number.isFinite(hunk.additionCount) &&
    Number.isFinite(hunk.deletionStart) &&
    Number.isFinite(hunk.deletionCount)
  );
}

/**
 * Summarize one parsed hunk into the stable index/header/range record.
 *
 * This is the one derivation behind every external view of a hunk — the agent
 * session surface (`SessionReviewHunk`) and the extension API
 * (`ExtensionDiffHunk`) — so the two can never drift apart on what a hunk's
 * header or line spans are.
 *
 * Pierre always parses full numeric headers, but a changeset transform may
 * synthesize a hunk, and validation only requires it to carry `hunkContent`.
 * Such a hunk gets whatever `hunkSpecs` text it declared (or an empty header)
 * and no ranges, rather than `NaN` spans an extension would have to guard.
 */
export function summarizeHunk(hunk: ReviewHunkHeaderSource, index: number): ExtensionDiffHunk {
  const rangesDerivable = hasLineNumbers(hunk);
  const formattedHeader = hunk.hunkSpecs != null || rangesDerivable ? formatHunkHeader(hunk) : "";
  return {
    index,
    // Public summaries are commonly embedded in terminal-safe extension rows, so keep this
    // boundary single-line without changing the raw header formatter used by Hunk itself.
    header: formattedHeader.replace(/[\r\n]+/g, " ").trimEnd(),
    ...(rangesDerivable ? reviewHunkRanges(hunk) : {}),
  };
}
