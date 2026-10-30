export const DEFAULT_FILE_GAP = 1;
export const DEFAULT_HUNK_GAP = 0;
export const MIN_REVIEW_GAP = 0;
export const MAX_REVIEW_GAP = 8;

/** Validate one file or hunk gap while keeping review-stream height practical. */
export function validateReviewGap(value: number, label = "review gap") {
  if (!Number.isSafeInteger(value) || value < MIN_REVIEW_GAP || value > MAX_REVIEW_GAP) {
    throw new Error(
      `Invalid ${label}: ${String(value)} (expected ${MIN_REVIEW_GAP}-${MAX_REVIEW_GAP})`,
    );
  }

  return value;
}

/** Parse one CLI file-gap or hunk-gap argument. */
export function parseReviewGap(value: string, label = "review gap") {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return validateReviewGap(Number(value), label);
}
