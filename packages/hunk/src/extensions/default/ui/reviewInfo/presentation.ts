import type {
  ExtensionChangeRequestReviewDescriptor,
  ExtensionCommitReviewDescriptor,
  ExtensionComparisonCommitDescriptor,
  ExtensionComparisonReviewDescriptor,
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
  | ExtensionCommitReviewDescriptor
  | ExtensionComparisonReviewDescriptor;

/** Join one metadata row after sanitizing optional provider fields. */
function reviewInfoRow(values: readonly (string | undefined)[]) {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(sanitizeReviewInfoText)
    .filter(Boolean)
    .join(" · ");
}

export interface CommitMetadataContent {
  text: string;
  author: string;
  relativeTime: string;
}

export interface ReviewInfoContent {
  primary: string;
  secondary: string;
  secondaryCommitMetadata?: CommitMetadataContent;
  /** Right-aligned identity on the primary row. */
  trailing?: string;
}

export interface ComparisonCommitContent {
  title: string;
  metadata: string;
  metadataAuthor: string;
  metadataRelativeTime: string;
  displayRevision: string;
  titleWidth: number;
  metadataWidth: number;
  revisionWidth: number;
}

/** Measure sanitized display text in terminal cells. */
function reviewInfoTextWidth(value: string) {
  return textClusters(value).reduce((sum, cluster) => sum + measureClusterWidth(cluster), 0);
}

/** Fit author and relative-time fields while preserving the timestamp first. */
export function commitMetadataContent({
  author,
  authoredAt,
  now,
  showAuthor,
  width,
}: {
  author?: string;
  authoredAt?: string;
  now: number;
  showAuthor: boolean;
  width: number;
}): CommitMetadataContent {
  const safeWidth = Math.max(0, width);
  const relativeTime = fitReviewInfoText(
    authoredAt ? formatHistoryRelativeTime(authoredAt, now) : "",
    safeWidth,
  );
  const relativeTimeWidth = reviewInfoTextWidth(relativeTime);
  const rawAuthor = showAuthor && author ? sanitizeReviewInfoText(author) : "";
  const authorBudget = Math.max(0, safeWidth - relativeTimeWidth - (rawAuthor ? 3 : 0));
  const fittedAuthor = fitReviewInfoText(rawAuthor, authorBudget);
  return {
    text: reviewInfoRow([fittedAuthor, relativeTime]),
    author: fittedAuthor,
    relativeTime,
  };
}

/** Fit one comparison commit into a single row with its revision pinned right. */
export function comparisonCommitContent(
  commit: ExtensionComparisonCommitDescriptor,
  width: number,
  now = Date.now(),
): ComparisonCommitContent {
  const safeWidth = Math.max(0, width);
  const showAuthor = safeWidth >= 64;
  const displayRevisionWidth = Math.min(
    12,
    reviewInfoTextWidth(commit.displayRevision),
    Math.max(0, safeWidth - 3),
  );
  const revisionWidth = displayRevisionWidth > 0 ? displayRevisionWidth + 2 : 0;
  const revisionSegmentWidth = revisionWidth > 0 ? revisionWidth + 1 : 0;
  const remainingAfterRevision = Math.max(0, safeWidth - revisionSegmentWidth);
  const metadataBudget = Math.min(
    24,
    Math.floor(safeWidth * 0.3),
    Math.max(0, remainingAfterRevision - 5),
  );
  const commitMetadata = commitMetadataContent({
    author: commit.author,
    authoredAt: commit.authoredAt,
    now,
    showAuthor,
    width: metadataBudget,
  });
  const metadataAuthor = commitMetadata.author;
  const metadataRelativeTime = commitMetadata.relativeTime;
  const metadata = commitMetadata.text;
  const metadataWidth = reviewInfoTextWidth(metadata);
  const metadataSegmentWidth = metadataWidth > 0 ? metadataWidth + 1 : 0;
  const titleWidth = Math.max(0, safeWidth - revisionSegmentWidth - metadataSegmentWidth);
  return {
    title: fitReviewInfoText(commit.title, titleWidth),
    metadata,
    metadataAuthor,
    metadataRelativeTime,
    displayRevision: fitReviewInfoText(commit.displayRevision, displayRevisionWidth),
    titleWidth,
    metadataWidth,
    revisionWidth,
  };
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
    const secondaryCommitMetadata = commitMetadataContent({
      author: review.author,
      authoredAt: review.authoredAt,
      now,
      showAuthor: true,
      width,
    });
    return {
      primary: fitReviewInfoText(review.title, primaryWidth),
      secondary: secondaryCommitMetadata.text,
      ...(secondaryCommitMetadata.text ? { secondaryCommitMetadata } : {}),
      ...(trailing ? { trailing } : {}),
    };
  }

  const refs = review.base && review.head ? `${review.base} ← ${review.head}` : undefined;
  if (review.kind === "comparison") {
    return {
      primary: fitReviewInfoText(review.title, width),
      secondary: fitReviewInfoText(reviewInfoRow([review.provider, refs]), width),
    };
  }

  const state = review.draft ? "DRAFT" : review.state?.toUpperCase();
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
