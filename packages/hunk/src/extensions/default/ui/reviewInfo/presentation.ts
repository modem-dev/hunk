import type { ExtensionChangeRequestReviewDescriptor } from "../../../../extension-api/types";
import { measureClusterWidth, textClusters } from "../../../../ui/lib/text";

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

/** Derive the two concise rows rendered by the bundled change-request pane. */
export function reviewInfoLines(
  review: ExtensionChangeRequestReviewDescriptor,
  width: number,
): readonly [string, string] {
  const state = review.draft ? "DRAFT" : review.state?.toUpperCase();
  const first = [state, review.id, review.title]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(sanitizeReviewInfoText)
    .filter(Boolean)
    .join(" · ");
  const refs = review.base && review.head ? `${review.base} ← ${review.head}` : undefined;
  const second = [review.author, review.provider, review.repository, refs]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(sanitizeReviewInfoText)
    .filter(Boolean)
    .join(" · ");
  return [fitReviewInfoText(first, width), fitReviewInfoText(second, width)];
}
