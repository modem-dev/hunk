import type {
  ExtensionChangeRequestReviewDescriptor,
  ExtensionCommitReviewDescriptor,
} from "../../../../extension-api/types";
import { formatHistoryRelativeTime } from "../../../../ui/log/formatting";
import { measureClusterWidth, textClusters } from "../../../../ui/lib/text";

const MIN_COMMIT_REVISION_DISPLAY_WIDTH = 4;

/** Collapse unsafe or layout-changing provider text into one deterministic terminal line. */
export function sanitizeReviewInfoText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Fit sanitized text to an exact terminal-cell budget with one ellipsis when clipped. */
export function fitReviewInfoText(value: string, width: number): string {
  const safe = sanitizeReviewInfoText(value);
  if (width <= 0) return "";
  const clusters = textClusters(safe);
  if (clusters.reduce((sum, cluster) => sum + measureClusterWidth(cluster), 0) <= width)
    return safe;
  if (width === 1) return "…";

  let used = 0;
  let fitted = "";
  for (const cluster of clusters) {
    const clusterWidth = measureClusterWidth(cluster);
    if (used + clusterWidth > width - 1) break;
    fitted += cluster;
    used += clusterWidth;
  }
  return `${fitted}…`;
}

type ReviewInfoDescriptor =
  | ExtensionChangeRequestReviewDescriptor
  | ExtensionCommitReviewDescriptor;

/** Join one metadata row after sanitizing optional provider fields. */
function reviewInfoRow(values: readonly (string | undefined)[]) {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(sanitizeReviewInfoText)
    .filter(Boolean)
    .join(" · ");
}

export interface ReviewInfoContent {
  primary: string;
  secondary: string;
  /** Right-aligned identity on the primary row. */
  trailing?: string;
}

/** Measure sanitized display text in terminal cells. */
function reviewInfoTextWidth(value: string) {
  return textClusters(value).reduce((sum, cluster) => sum + measureClusterWidth(cluster), 0);
}

/** Derive the concise rows and optional right edge rendered by the review-info pane. */
export function reviewInfoContent(
  review: ReviewInfoDescriptor,
  width: number,
  now = Date.now(),
): ReviewInfoContent {
  if (review.kind === "commit") {
    const trailingWidth = Math.max(0, Math.min(width, Math.floor(width * 0.35)));
    const trailing =
      trailingWidth >= MIN_COMMIT_REVISION_DISPLAY_WIDTH && width - trailingWidth - 2 >= 1
        ? fitReviewInfoText(review.revision, trailingWidth)
        : "";
    // Reserve one cell each for the gap before the id and its adjacent copy action.
    const primaryWidth = Math.max(0, width - reviewInfoTextWidth(trailing) - (trailing ? 2 : 0));
    const relativeTime = review.authoredAt
      ? formatHistoryRelativeTime(review.authoredAt, now)
      : undefined;
    return {
      primary: fitReviewInfoText(review.title, primaryWidth),
      secondary: fitReviewInfoText(reviewInfoRow([review.author, relativeTime]), width),
      ...(trailing ? { trailing } : {}),
    };
  }

  const state = review.draft ? "DRAFT" : review.state?.toUpperCase();
  const refs = review.base && review.head ? `${review.base} ← ${review.head}` : undefined;
  return {
    primary: fitReviewInfoText(reviewInfoRow([state, review.id, review.title]), width),
    secondary: fitReviewInfoText(
      reviewInfoRow([review.author, review.provider, review.repository, refs]),
      width,
    ),
  };
}

/** Return only the two left-aligned rows for callers that do not paint the trailing identity. */
export function reviewInfoLines(
  review: ReviewInfoDescriptor,
  width: number,
  now = Date.now(),
): readonly [string, string] {
  const content = reviewInfoContent(review, width, now);
  return [content.primary, content.secondary];
}
