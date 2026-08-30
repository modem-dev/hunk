import { describe, expect, test } from "bun:test";
import {
  isClientReviewViewOption,
  REVIEW_VIEW_OPTION_LOCUS,
  type ReviewViewOptionLocus,
} from "./viewOptions";

describe("REVIEW_VIEW_OPTION_LOCUS", () => {
  // Stated by hand rather than read back out of the table, so a classification changed by
  // accident fails here instead of being re-asserted from itself.
  const EXPECTED: Record<string, ReviewViewOptionLocus> = {
    filter: "review",
    showAgentNotes: "review",
    mode: "client",
    theme: "client",
    showLineNumbers: "client",
    wrapLines: "client",
    showHunkHeaders: "client",
    showMenuBar: "client",
    copyDecorations: "client",
    cursorLine: "client",
  };

  test("classifies every option exactly once", () => {
    expect(REVIEW_VIEW_OPTION_LOCUS).toEqual(EXPECTED as typeof REVIEW_VIEW_OPTION_LOCUS);
  });

  test("agrees with the predicate clients gate their own overrides on", () => {
    for (const [option, locus] of Object.entries(REVIEW_VIEW_OPTION_LOCUS)) {
      expect(isClientReviewViewOption(option as keyof typeof REVIEW_VIEW_OPTION_LOCUS)).toBe(
        locus === "client",
      );
    }
  });
});
