/**
 * Words the page's failures: the shared catalog's sentence for every review code, plus the two
 * transport conditions no review code describes (an unreachable daemon, an unreadable answer).
 *
 * The page never words a review failure itself; every surface that shows one — the page-level
 * error, a composer, a toast — goes through `reviewFailureMessage`.
 */
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import type { ReviewApiError } from "../transport/apiClient";

/** Shown when the daemon cannot be reached at all, which no review failure code describes. */
export const REVIEW_UNREACHABLE_MESSAGE =
  "The Hunk session daemon did not answer. Check that the review is still running, then reload.";

/** Shown for a response this build cannot read, which no review failure code describes. */
export const REVIEW_UNREADABLE_MESSAGE = "The Hunk session sent a response this page cannot read.";

/** One sentence for one failure, from the shared catalog wherever the code is a review code. */
export function reviewFailureMessage(error: ReviewApiError | undefined) {
  if (!error || error.code === "unreadable") return REVIEW_UNREADABLE_MESSAGE;
  if (error.code === "network") return REVIEW_UNREACHABLE_MESSAGE;
  return reviewErrorMessage(error.code);
}
