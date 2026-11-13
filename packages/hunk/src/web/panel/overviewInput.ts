/**
 * Feeds the shared overview selector from what the page holds: its file index and the
 * shared-state snapshot's notes and viewed marks.
 *
 * Every number the Overview tab shows comes from `selectReviewOverview` in
 * `core/review/overview.ts`; this module only adapts the page's inputs to it, so the tab, the
 * conformance corpus, and later `hunk session` report the same figures.
 */
import {
  reviewOverviewNoteOrigin,
  selectReviewOverview,
  type ReviewOverview,
  type ReviewOverviewFileInput,
} from "../../core/review/overview";
import type { ReviewSharedStateV1 } from "../../session/reviewSharedState";

/** Summarize the given files with the snapshot's notes and viewed marks. */
export function selectWebReviewOverview(
  files: readonly ReviewOverviewFileInput[],
  shared: Pick<ReviewSharedStateV1, "notes" | "viewedFiles"> | undefined,
): ReviewOverview {
  return selectReviewOverview({
    files,
    notes: (shared?.notes ?? []).map((entry) => ({
      fileKey: entry.note.fileKey,
      origin: reviewOverviewNoteOrigin(entry.note.source),
    })),
    ...(shared ? { viewedFiles: shared.viewedFiles } : {}),
  });
}
