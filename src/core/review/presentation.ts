/**
 * Renderer-neutral formatting of the facts a review carries.
 *
 * Some presentation is not renderer-specific at all: how a file's line churn reads as a
 * badge is the same string in a terminal row and in a browser sidebar, and the prototype
 * had them differ — the terminal hid zero counts and marked truncation, the browser always
 * printed `+n −n` (`docs/browser-review-seam-audit.md`, E1). The text is decided here so
 * one review cannot describe the same file two ways depending on which surface is looking.
 *
 * Only text belongs in this module. Colors, widths, glyph choice, and placement are the
 * renderer's, and nothing here reaches for a theme or measures a cell.
 */
/** The stats one file's badges are built from; `ReviewFileStatsV1` satisfies it. */
export interface ReviewStatSubject {
  additions: number;
  deletions: number;
  /** The producer counted more than it rendered, so the numbers are a lower bound. */
  truncated?: boolean;
}

export interface ReviewFileStatBadges {
  /** `+12`, or `+12+` when the count is a lower bound; null when nothing was added. */
  additionsText: string | null;
  /** `-3`; null when nothing was deleted. */
  deletionsText: string | null;
}

/** Render one signed count, hiding a zero so a badge only ever states a real delta. */
function formatReviewStat(prefix: "+" | "-", value: number, truncated: boolean) {
  return value > 0 ? `${prefix}${value}${truncated ? "+" : ""}` : null;
}

/**
 * The line-churn badges one reviewed file shows.
 *
 * Two policies, stated rather than implied by where the code is read from: a zero count is
 * hidden entirely, and truncation is reported once — on the additions badge — because one
 * marker per file is enough to say both numbers are lower bounds, and repeating it reads
 * as two separate truncations.
 */
export function reviewFileStatBadges(stats: ReviewStatSubject): ReviewFileStatBadges {
  const truncated = stats.truncated ?? false;
  return {
    additionsText: formatReviewStat("+", stats.additions, truncated),
    deletionsText: formatReviewStat("-", stats.deletions, false),
  };
}
