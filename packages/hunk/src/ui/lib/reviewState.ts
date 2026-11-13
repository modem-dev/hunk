/**
 * Pure review-stream derivation helpers used by `useTerminalReview`.
 *
 * This module turns raw diff files plus live comments into the current visible review state.
 * It stays side-effect free so stream rules can be tested without React state in the loop.
 * Absolute session-daemon navigation targets and selection repair live in
 * `app/review/reviewSessionProjections.ts`.
 *
 * Relative navigation lives in `core/review/navigation.ts` and the annotation index it
 * plans against in `core/review/annotations.ts`: both are shared with every other review
 * surface rather than derived per renderer.
 */
import { reviewFileMatchesFilter } from "../../core/review/selectors";
import type { DiffFile } from "../../core/changeset/model";
import type { AgentAnnotation } from "../../extension-api/types";
import { mergeFileAnnotationsByFileId } from "./files";

// Absolute navigation and selected-hunk summaries are session semantics owned by the review
// session host's projections; re-exported for existing importers.
export {
  buildSelectedHunkSummary,
  planReviewSelectionRepair as planTerminalSelectionReconciliation,
  resolveReviewNavigationTarget,
  type ReviewNavigationTarget,
} from "../../app/review/reviewSessionProjections";

export interface BuildReviewStreamStateOptions {
  files: DiffFile[];
  liveCommentsByFileId: Record<string, AgentAnnotation[]>;
  filterQuery: string;
}

export interface ReviewStreamState {
  allFiles: DiffFile[];
  visibleFiles: DiffFile[];
}

/** Build selection-independent review stream state from files and filter text. */
export function buildReviewStreamState({
  files,
  liveCommentsByFileId,
  filterQuery,
}: BuildReviewStreamStateOptions): ReviewStreamState {
  const allFiles = mergeFileAnnotationsByFileId(files, liveCommentsByFileId);

  return {
    allFiles,
    // The shared matcher, not a terminal copy of it: sidebar, review stream, and every
    // other surface must agree on what one query matches.
    visibleFiles: allFiles.filter((file) =>
      reviewFileMatchesFilter(
        {
          path: file.path,
          ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
          ...(file.agent?.summary !== undefined ? { agentSummary: file.agent.summary } : {}),
        },
        filterQuery,
      ),
    ),
  };
}
