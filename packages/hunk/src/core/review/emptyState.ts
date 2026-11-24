/**
 * Words the review stream's empty state when the shared filter hides every file, for every
 * surface.
 *
 * The terminal and the browser page tell two empty streams apart: a review that holds no files,
 * which each surface words in its own voice, and a review whose files the shared filter hides
 * all of, which both word the same way so a reader switching surfaces sees one answer. A review
 * with no files takes precedence: an empty review never claims that a filter hid its files.
 */

/** The stream's empty state when the review has files but the shared filter matches none. */
export const REVIEW_FILTER_NO_MATCH_MESSAGE = "No files match the current filter.";
