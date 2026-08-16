import { describe, expect, test } from "bun:test";
import { reviewFileStatBadges } from "./presentation";

describe("reviewFileStatBadges", () => {
  test("states both deltas", () => {
    expect(reviewFileStatBadges({ additions: 12, deletions: 3 })).toEqual({
      additionsText: "+12",
      deletionsText: "-3",
    });
  });

  test("hides a zero rather than printing it", () => {
    expect(reviewFileStatBadges({ additions: 0, deletions: 4 })).toEqual({
      additionsText: null,
      deletionsText: "-4",
    });
    expect(reviewFileStatBadges({ additions: 4, deletions: 0 })).toEqual({
      additionsText: "+4",
      deletionsText: null,
    });
    expect(reviewFileStatBadges({ additions: 0, deletions: 0 })).toEqual({
      additionsText: null,
      deletionsText: null,
    });
  });

  test("marks truncation once, on the additions badge", () => {
    expect(reviewFileStatBadges({ additions: 900, deletions: 800, truncated: true })).toEqual({
      additionsText: "+900+",
      deletionsText: "-800",
    });
  });

  test("does not mark truncation on a file with nothing added", () => {
    expect(reviewFileStatBadges({ additions: 0, deletions: 800, truncated: true })).toEqual({
      additionsText: null,
      deletionsText: "-800",
    });
  });
});
