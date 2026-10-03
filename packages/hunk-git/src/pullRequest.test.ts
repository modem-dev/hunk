import { describe, expect, test } from "bun:test";
import type { ExtensionVcsHistoryCommit } from "hunkdiff/extension";
import { gitHistoryPullRequestUrl, parseGitHubRemoteRepository } from "./pullRequest";

const repository = { owner: "modem-dev", repo: "hunk" };

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

describe("GitHub remote parsing", () => {
  test("parses common github.com remote forms", () => {
    for (const remote of [
      "https://github.com/modem-dev/hunk.git",
      "https://github.com/modem-dev/hunk",
      "ssh://git@github.com/modem-dev/hunk.git",
      "git://github.com/modem-dev/hunk.git",
      "git@github.com:modem-dev/hunk.git",
      "git@github.com:modem-dev/hunk",
    ]) {
      expect(parseGitHubRemoteRepository(remote)).toEqual(repository);
    }
  });

  test("rejects non-GitHub and malformed remotes", () => {
    for (const remote of [
      "",
      "https://gitlab.com/modem-dev/hunk.git",
      "https://github.com/modem-dev/hunk/extra.git",
      "git@github.com:modem-dev.git",
      "git@github.com:./hunk.git",
      "not a remote",
    ]) {
      expect(parseGitHubRemoteRepository(remote)).toBeNull();
    }
  });
});

describe("Git history pull-request URLs", () => {
  test("builds merge and squash URLs from origin", () => {
    expect(
      gitHistoryPullRequestUrl(
        commit({ subject: "Merge pull request #42 from octocat/patch" }),
        repository,
      ),
    ).toBe("https://github.com/modem-dev/hunk/pull/42");
    expect(gitHistoryPullRequestUrl(commit({ subject: "Fix the parser (#7)" }), repository)).toBe(
      "https://github.com/modem-dev/hunk/pull/7",
    );
  });

  test("does not invent a URL without a github.com origin or a merge/squash subject", () => {
    expect(
      gitHistoryPullRequestUrl(commit({ subject: "Merge pull request #42 from octocat/patch" })),
    ).toBeUndefined();
    expect(gitHistoryPullRequestUrl(commit(), repository)).toBeUndefined();
    expect(
      gitHistoryPullRequestUrl(
        commit({
          subject: "Explain the change",
          body: "See https://github.com/acme/tools/pull/9",
        }),
        repository,
      ),
    ).toBeUndefined();
    expect(
      gitHistoryPullRequestUrl(commit({ subject: "Fix handling (#2 in series)" }), repository),
    ).toBeUndefined();
  });
});
