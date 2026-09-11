import { describe, expect, test } from "bun:test";
import type { ExtensionVcsHistoryCommit } from "../../extension-api/types";
import { historyPullRequestCopyNotice, resolveHistoryPullRequestUrl } from "./pullRequestUrl";

const commit = (overrides: Partial<ExtensionVcsHistoryCommit> = {}): ExtensionVcsHistoryCommit => ({
  revisionId: "a".repeat(40),
  displayId: "aaaaaaaa",
  parentRevisionIds: [],
  subject: "Fix the parser",
  authorName: "Ada",
  authoredAt: "2026-01-01T00:00:00Z",
  decorations: [],
  ...overrides,
});

describe("history pull-request URLs", () => {
  test("copies a provider-supplied pull-request URL", () => {
    expect(
      resolveHistoryPullRequestUrl(
        commit({ pullRequestUrl: "https://github.com/modem-dev/hunk/pull/42" }),
      ),
    ).toBe("https://github.com/modem-dev/hunk/pull/42");
    expect(
      resolveHistoryPullRequestUrl(
        commit({ subject: "Merge pull request #42 from octocat/patch" }),
      ),
    ).toBeUndefined();
  });

  test("names the copied pull request when the URL ends with its number", () => {
    expect(historyPullRequestCopyNotice("https://github.com/modem-dev/hunk/pull/42")).toBe(
      "Copied pull request #42",
    );
    expect(historyPullRequestCopyNotice("https://example.com/review")).toBe(
      "Copied pull request URL",
    );
  });
});
