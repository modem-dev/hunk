import { describe, expect, test } from "bun:test";
import {
  forgetClearedViewedMarks,
  forgetViewedMark,
  formatReviewViewedProgress,
  rememberViewedMarks,
  reviewViewedStatus,
  reviewViewedVisibility,
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

  // Intent: a mark cleared in another browser or the terminal leaves the shared state while the
  // content still matches; forgetting it then keeps a later change from saying "Changed since
  // viewed" about a mark the reader already cleared.
  test("forgets a mark cleared elsewhere and keeps one a content change dropped", () => {
    const beta = { key: "file:beta", contentIdentity: "content:b1" };
    const memory = { [alpha.key]: "content:a2", [beta.key]: "content:b0" };

    const reconciled = forgetClearedViewedMarks(memory, [alpha, beta], {});
    expect(reconciled).toEqual({ [beta.key]: "content:b0" });
    expect(reviewViewedStatus(beta, {}, reconciled)).toBe("changed");
    // The cleared file changes later: it is simply not viewed.
    expect(reviewViewedStatus({ ...alpha, contentIdentity: "content:a3" }, {}, reconciled)).toBe(
      "unviewed",
    );

    const marked = { [alpha.key]: { contentIdentity: "content:a2" } };
    expect(forgetClearedViewedMarks(memory, [alpha], marked)).toBe(memory);
    expect(forgetClearedViewedMarks(memory, [], {})).toBe(memory);
  });

  // Intent: one jump-revealed file is shown and expanded despite "Hide viewed"; a navigation
  // opening a file and the reader's own expansion only uncollapse it.
  test("hides and collapses viewed files except the one a jump revealed", () => {
    const statuses = new Map([
      ["a", "viewed"],
      ["b", "viewed"],
      ["c", "viewed"],
      ["d", "changed"],
    ] as const);
    const visibility = reviewViewedVisibility(statuses, {
      hideViewed: true,
      expanded: new Set(["b"]),
      opening: "c",
      revealed: "a",
    });

    expect([...visibility.hidden].sort()).toEqual(["b", "c"]);
    expect([...visibility.collapsed]).toEqual([]);
    expect(
      [
        ...reviewViewedVisibility(statuses, {
          hideViewed: false,
          expanded: new Set(),
          opening: null,
          revealed: null,
        }).collapsed,
      ].sort(),
    ).toEqual(["a", "b", "c"]);
  });

  test("labels progress as the toolbar shows it", () => {
    expect(formatReviewViewedProgress({ viewed: 12, total: 47 })).toBe("12 of 47 viewed");
  });
});
