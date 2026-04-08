export interface ReviewSummary {
  title: string;
  confidence: number;
  tags: string[];
}

export function formatReviewSummary(summary: ReviewSummary) {
  const tagSuffix = summary.tags.length > 0 ? ` [${summary.tags.join(", ")}]` : "";
  return `${summary.title} (${summary.confidence})${tagSuffix}`;
}
