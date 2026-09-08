import { describe, expect, test } from "bun:test";
import {
  parseExtensionReviewDescriptor,
  validateExtensionReviewDescriptor,
} from "./reviewDescriptor";

const review = {
  kind: "change-request" as const,
  provider: "GitHub",
  title: "Review metadata",
  id: "#123",
  repository: "modem-dev/hunk",
  state: "open" as const,
};

describe("review descriptor validation", () => {
  test("copies, freezes, and accepts every descriptor kind", () => {
    const parsed = validateExtensionReviewDescriptor(review);
    expect(parsed).toEqual(review);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      validateExtensionReviewDescriptor({
        kind: "commit",
        provider: "GitHub",
        title: "Commit",
        revision: "abc1234",
        displayRevision: "abc1234",
        authoredAt: "2026-01-01T00:00:00Z",
      }),
    ).toMatchObject({
      kind: "commit",
      revision: "abc1234",
      displayRevision: "abc1234",
      authoredAt: "2026-01-01T00:00:00Z",
    });
    expect(
      validateExtensionReviewDescriptor({
        kind: "comparison",
        provider: "GitHub",
        title: "Comparison",
        base: "main",
        head: "feature",
        commitCount: 1,
        commits: [
          {
            title: "Commit",
            author: "Ada",
            authoredAt: "2026-01-01T00:00:00Z",
            revision: "abc1234",
            displayRevision: "abc1234",
          },
        ],
      }),
    ).toMatchObject({ kind: "comparison", base: "main", head: "feature", commitCount: 1 });
    expect(
      validateExtensionReviewDescriptor({
        kind: "comparison",
        provider: "Git",
        title: "0 commits",
        base: "main",
        head: "main",
        commitCount: 0,
      }),
    ).toMatchObject({ kind: "comparison", commitCount: 0 });
  });

  test("rejects unknown fields, controls, insecure URLs, and byte overflows", () => {
    for (const value of [
      { ...review, unknown: true },
      { ...review, title: "bad\u001b[31m" },
      { ...review, url: "http://github.com/modem-dev/hunk/pull/123" },
      { ...review, title: "é".repeat(1025) },
      { ...review, repository: "x".repeat(513) },
      {
        kind: "commit",
        provider: "GitHub",
        title: "Commit",
        revision: "abc1234",
        displayRevision: "abc1234",
        authoredAt: "yesterday",
      },
      {
        ...review,
        provider: "p".repeat(256),
        title: "t".repeat(2 * 1024),
        repository: "r".repeat(512),
        author: "a".repeat(512),
        base: "b".repeat(512),
        head: "h".repeat(512),
      },
    ]) {
      expect(parseExtensionReviewDescriptor(value)).toBeNull();
    }
  });

  test("keeps pre-v24 commit descriptors valid without a display revision", () => {
    expect(
      validateExtensionReviewDescriptor({
        kind: "commit",
        provider: "GitHub",
        title: "Commit",
        revision: "0123456789abcdef",
      }),
    ).toEqual({
      kind: "commit",
      provider: "GitHub",
      title: "Commit",
      revision: "0123456789abcdef",
    });
  });
});
