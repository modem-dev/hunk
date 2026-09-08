import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILE_GAP,
  DEFAULT_HUNK_GAP,
  MAX_REVIEW_GAP,
  MIN_REVIEW_GAP,
  parseReviewGap,
  validateReviewGap,
} from "./reviewGap";

describe("review gap", () => {
  test("keeps the current stream look as the built-in defaults", () => {
    expect(DEFAULT_FILE_GAP).toBe(1);
    expect(DEFAULT_HUNK_GAP).toBe(0);
  });

  test("accepts the inclusive 0-8 range", () => {
    expect(validateReviewGap(MIN_REVIEW_GAP)).toBe(0);
    expect(validateReviewGap(MAX_REVIEW_GAP)).toBe(8);
    expect(parseReviewGap("0", "file gap")).toBe(0);
    expect(parseReviewGap("3", "hunk gap")).toBe(3);
  });

  test("rejects values outside the range", () => {
    expect(() => validateReviewGap(-1, "file_gap")).toThrow(/file_gap/);
    expect(() => validateReviewGap(9, "hunk_gap")).toThrow(/hunk_gap/);
    expect(() => parseReviewGap("9", "file gap")).toThrow(/file gap/);
    expect(() => parseReviewGap("-1", "hunk gap")).toThrow(/hunk gap/);
    expect(() => parseReviewGap("2x", "file gap")).toThrow(/file gap/);
  });
});
