import { describe, expect, test } from "bun:test";
import {
  comparisonCommitContent,
  fitReviewInfoText,
  reviewInfoContent,
  reviewInfoLines,
  sanitizeReviewInfoText,
} from "./presentation";

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

  test("formats commit identity and provider facts into two lines", () => {
    const content = reviewInfoContent(
      {
        kind: "commit",
        provider: "GitHub",
        title: "Render commit review metadata",
        revision: "abc1234",
        displayRevision: "abc1234",
        author: "octocat",
        authoredAt: "2026-01-01T00:00:00Z",
      },
      200,
      Date.parse("2026-01-01T10:00:00Z"),
    );
    expect(content).toEqual({
      primary: "Render commit review metadata",
      secondary: "octocat · 10 hours ago",
      secondaryCommitMetadata: {
        text: "octocat · 10 hours ago",
        author: "octocat",
        relativeTime: "10 hours ago",
      },
      trailing: "abc1234",
    });
  });

  test("fits comparison commits responsively while keeping the revision pinned", () => {
    const commit = {
      title: "Keep comparison metadata visible in narrow terminals",
      author: "Ada",
      authoredAt: "2026-01-01T00:00:00Z",
      revision: "a9c17e2f00000000000000000000000000000000",
      displayRevision: "a9c17e2f",
    };
    expect(comparisonCommitContent(commit, 80, Date.parse("2026-01-01T02:00:00Z"))).toEqual({
      title: "Keep comparison metadata visible in narrow termina…",
      metadata: "Ada · 2 hours ago",
      metadataAuthor: "Ada",
      metadataRelativeTime: "2 hours ago",
      displayRevision: "a9c17e2f",
      titleWidth: 51,
      metadataWidth: 17,
      revisionWidth: 10,
    });
    expect(comparisonCommitContent(commit, 42, Date.parse("2026-01-01T02:00:00Z"))).toEqual({
      title: "Keep comparison me…",
      metadata: "2 hours ago",
      metadataAuthor: "",
      metadataRelativeTime: "2 hours ago",
      displayRevision: "a9c17e2f",
      titleWidth: 19,
      metadataWidth: 11,
      revisionWidth: 10,
    });
    for (let width = 0; width < 20; width += 1) {
      const row = comparisonCommitContent(commit, width);
      const allocated =
        row.titleWidth +
        (row.metadataWidth ? row.metadataWidth + 1 : 0) +
        (row.revisionWidth ? row.revisionWidth + 1 : 0);
      expect(allocated).toBeLessThanOrEqual(width);
    }
  });

  test("formats a direct comparison with provider and endpoint direction", () => {
    expect(
      reviewInfoContent(
        {
          kind: "comparison",
          provider: "Git",
          title: "3 commits",
          base: "base1234",
          head: "head5678",
        },
        200,
      ),
    ).toEqual({
      primary: "3 commits",
      secondary: "Git · base1234 ← head5678",
    });
  });

  test("caps a long commit id so narrow layouts retain the title", () => {
    expect(
      reviewInfoContent(
        {
          kind: "commit",
          provider: "Git",
          title: "Visible title",
          revision: "1234567890abcdef",
          displayRevision: "12345678",
          author: "ada",
        },
        20,
      ),
    ).toEqual({
      primary: "Visible ti…",
      secondary: "ada",
      secondaryCommitMetadata: { text: "ada", author: "ada", relativeTime: "" },
      trailing: "123456…",
    });
  });

  test("keeps the title instead of showing an unusable revision at tiny widths", () => {
    const commit = {
      kind: "commit" as const,
      provider: "Git",
      title: "Title",
      revision: "1234567890abcdef",
      displayRevision: "12345678",
    };
    expect(reviewInfoContent(commit, 6)).toEqual({ primary: "Title", secondary: "" });
    expect(reviewInfoContent(commit, 12)).toEqual({
      primary: "Title",
      secondary: "",
      trailing: "123…",
    });
  });

  test("abbreviates legacy commit revisions that do not provide a display id", () => {
    expect(
      reviewInfoContent(
        {
          kind: "commit",
          provider: "Git",
          title: "Legacy extension commit",
          revision: "0123456789abcdef0123456789abcdef01234567",
        },
        80,
      ).trailing,
    ).toBe("01234567");
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
