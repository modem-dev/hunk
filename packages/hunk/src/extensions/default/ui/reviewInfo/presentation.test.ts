import { describe, expect, test } from "bun:test";
import { fitReviewInfoText, reviewInfoLines, sanitizeReviewInfoText } from "./presentation";

const review = {
  kind: "change-request" as const,
  provider: "GitHub",
  title: "Add delegated review metadata",
  id: "#123",
  repository: "modem-dev/hunk",
  author: "octocat",
  base: "main",
  head: "feature/review-info",
  state: "open" as const,
};

describe("review info presentation", () => {
  test("formats state, reference, identity, and refs into two lines", () => {
    expect(reviewInfoLines(review, 200)).toEqual([
      "OPEN · #123 · Add delegated review metadata",
      "octocat · GitHub · modem-dev/hunk · main ← feature/review-info",
    ]);
    expect(reviewInfoLines({ ...review, draft: true, state: "closed" }, 200)[0]).toStartWith(
      "DRAFT · #123",
    );
  });

  test("omits unknown state while preserving explicit draft identity", () => {
    const { state: _state, ...withoutState } = review;
    expect(reviewInfoLines(withoutState, 200)[0]).toBe("#123 · Add delegated review metadata");
    expect(reviewInfoLines({ ...withoutState, draft: false }, 200)[0]).toBe(
      "#123 · Add delegated review metadata",
    );
    expect(reviewInfoLines({ ...withoutState, draft: true }, 200)[0]).toBe(
      "DRAFT · #123 · Add delegated review metadata",
    );
  });

  test("sanitizes control characters and collapses layout-changing whitespace", () => {
    expect(sanitizeReviewInfoText("hello\n\u001b[31m  world")).toBe("hello [31m world");
    const lines = reviewInfoLines({ ...review, title: "unsafe\r\ntitle" }, 200);
    expect(lines[0]).toBe("OPEN · #123 · unsafe title");
  });

  test("fits narrow and wide-character text deterministically", () => {
    expect(fitReviewInfoText("abcdef", 6)).toBe("abcdef");
    expect(fitReviewInfoText("abcdef", 5)).toBe("abcd…");
    expect(fitReviewInfoText("界界界", 5)).toBe("界界…");
    expect(fitReviewInfoText("abcdef", 1)).toBe("…");
    expect(fitReviewInfoText("abcdef", 0)).toBe("");
  });
});
