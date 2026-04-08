export interface ReviewSummary {
  title: string;
  confidence: number;
}

export function summarizeReview(summary: ReviewSummary) {
  return `${summary.title} (${summary.confidence})`;
}
