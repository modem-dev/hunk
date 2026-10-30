import { describe, expect, test } from "bun:test";
import { parseSlReviewCommits } from "./reviewInfo";

describe("Sapling direct review metadata", () => {
  test("parses commit fields from the bounded machine template", () => {
    const revision = "a".repeat(40);
    expect(
      parseSlReviewCommits(
        [
          revision,
          revision.slice(0, 12),
          "Direct Sapling commit",
          "Test User",
          "test@example.com",
          "2026-09-08 12:00:00 +0000",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      {
        revisionId: revision,
        displayId: revision.slice(0, 12),
        parentRevisionIds: [],
        subject: "Direct Sapling commit",
        authorName: "Test User",
        authorEmail: "test@example.com",
        authoredAt: "2026-09-08T12:00:00.000Z",
        decorations: [],
      },
    ]);
  });

  test("rejects truncated or invalid commit records", () => {
    expect(() => parseSlReviewCommits("partial\0record\0")).toThrow("truncated");
    expect(() =>
      parseSlReviewCommits(
        ["not-a-node", "short", "title", "author", "email", "2026-09-08", ""].join("\0"),
      ),
    ).toThrow("invalid review commit id");
  });
});
