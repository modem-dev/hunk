/**
 * The size badge's words, shared by the summary strip and the Overview tab so both name a size
 * class and explain its thresholds the same way.
 */
import type { ReviewSizeClass } from "../../core/review/overview";

/** The long name of each size class. */
export const SIZE_LABELS: Record<ReviewSizeClass, string> = {
  XS: "Extra small",
  S: "Small",
  M: "Medium",
  L: "Large",
  XL: "Extra large",
};

/** What the size badge's title says about how the class was decided. */
export const SIZE_BADGE_TITLE =
  "Size by meaningful changed lines: under 10 XS, 30 S, 100 M, 500 L; XL beyond";
