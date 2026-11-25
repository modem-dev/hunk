/**
 * Words the review stream's empty states, shared by the terminal and the browser page.
 *
 * Both surfaces tell two empty streams apart, in the same words so a reader switching surfaces
 * sees one answer: a review that holds no files, and a review whose files the shared filter
 * hides all of. A review with no files takes precedence: an empty review never claims that a
 * filter hid its files. A surface's own hiding (the page's "Hide viewed") words its own case.
 */

/** The stream's empty state when the review holds no files. */
export const REVIEW_EMPTY_MESSAGE = "No changes to review.";

/** The stream's empty state when the review has files but the shared filter matches none. */
export const REVIEW_FILTER_NO_MATCH_MESSAGE = "No files match the current filter.";
