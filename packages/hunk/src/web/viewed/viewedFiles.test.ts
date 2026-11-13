import { describe, expect, test } from "bun:test";
import {
  forgetViewedMark,
  formatReviewViewedProgress,
  rememberViewedMarks,
  reviewViewedStatus,
} from "./viewedFiles";

const alpha = { key: "file:alpha", contentIdentity: "content:a2" };

describe("viewed files", () => {
  test("a current mark is viewed whatever the memory says", () => {
    expect(reviewViewedStatus(alpha, { [alpha.key]: { contentIdentity: "content:a2" } }, {})).toBe(
      "viewed",
    );
    expect(
      reviewViewedStatus(
        alpha,
        { [alpha.key]: { contentIdentity: "content:a2" } },
        { [alpha.key]: "content:a1" },
      ),
    ).toBe("viewed");
  });

  test("a file remembered at other content and not marked now changed since it was viewed", () => {
    expect(reviewViewedStatus(alpha, {}, { [alpha.key]: "content:a1" })).toBe("changed");
    // Remembered at its current content but not marked: someone cleared the mark.
    expect(reviewViewedStatus(alpha, {}, { [alpha.key]: "content:a2" })).toBe("unviewed");
    expect(reviewViewedStatus(alpha, {}, {})).toBe("unviewed");
    // A mark at other content is never treated as current, even if a snapshot carried one.
    expect(reviewViewedStatus(alpha, { [alpha.key]: { contentIdentity: "content:a1" } }, {})).toBe(
      "unviewed",
    );
  });

  test("remembers every shared mark and keeps the same object when nothing changed", () => {
    const marks = { [alpha.key]: { contentIdentity: "content:a2" } };
    const memory = rememberViewedMarks({}, marks);
    expect(memory).toEqual({ [alpha.key]: "content:a2" });
    expect(rememberViewedMarks(memory, marks)).toBe(memory);
    // A mark that disappeared is not forgotten: that is what "changed since viewed" reads.
    expect(rememberViewedMarks(memory, {})).toBe(memory);
    expect(forgetViewedMark(memory, alpha.key)).toEqual({});
    expect(forgetViewedMark({}, alpha.key)).toEqual({});
  });

  test("labels progress as the toolbar shows it", () => {
    expect(formatReviewViewedProgress({ viewed: 12, total: 47 })).toBe("12 of 47 viewed");
  });
});
