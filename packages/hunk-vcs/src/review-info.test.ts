import { describe, expect, test } from "bun:test";
import { commitReviewInfo, comparisonReviewInfo, vcsReviewAuthorLabel } from "./review-info";

const commit = {
  revisionId: "a".repeat(40),
  displayId: "aaaaaaaa",
  subject: "Direct commit",
  authorName: "Test User",
  authorEmail: "123+octocat@users.noreply.github.com",
  authoredAt: "2026-09-08T12:00:00Z",
};

describe("provider-neutral review info", () => {
  test("uses the same offline author labels and bounded display fields as history", () => {
    expect(vcsReviewAuthorLabel(commit)).toBe("octocat");
    expect(
      commitReviewInfo("Git", { ...commit, subject: `Direct\n${"界".repeat(1_000)}` }),
    ).toEqual({
      kind: "commit",
      provider: "Git",
      title: `Direct ${"界".repeat(680)}`,
      revision: commit.revisionId,
      displayRevision: commit.displayId,
      author: "octocat",
      authoredAt: commit.authoredAt,
    });
  });

  test("builds newest-first comparison rows with an exact total when known", () => {
    expect(comparisonReviewInfo("Git", "base", "head", [commit], 3)).toEqual({
      kind: "comparison",
      provider: "Git",
      title: "3 commits",
      base: "base",
      head: "head",
      commitCount: 3,
      commits: [
        {
          title: "Direct commit",
          author: "octocat",
          authoredAt: commit.authoredAt,
          revision: commit.revisionId,
          displayRevision: commit.displayId,
        },
      ],
    });
  });
});
