import type { ExtensionVcsHistoryCommit } from "hunkdiff/extension";

const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const MERGE_PULL_REQUEST = /^Merge pull request #([1-9]\d*)\b/i;
const SQUASH_PULL_REQUEST = /\(#([1-9]\d*)\)$/;

export interface GitHubRepository {
  owner: string;
  repo: string;
}

/** Validate and normalize one owner/repository pair. */
function parseGitHubRepository(value: string): GitHubRepository | null {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (
    !REPOSITORY_PART.test(parts[0]) ||
    !REPOSITORY_PART.test(parts[1]) ||
    parts[0] === "." ||
    parts[0] === ".." ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Accept a GitHub pull-request number that fits in a safe integer. */
function parsePullRequestNumber(value: string): string | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  if (!Number.isSafeInteger(Number(value))) return undefined;
  return value;
}

/** Parse a github.com remote URL into its owner and repository. */
export function parseGitHubRemoteRepository(value: string): GitHubRepository | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const scp = /^(?:[^@\s]+@)?github\.com:([^/\s]+\/[^/\s]+)$/i.exec(trimmed);
  let repositoryPath: string | undefined;
  if (scp) {
    repositoryPath = scp[1];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (
      !["https:", "ssh:", "git:"].includes(url.protocol) ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    repositoryPath = url.pathname.replace(/^\//, "");
  }

  if (!repositoryPath) return null;
  return parseGitHubRepository(repositoryPath.replace(/\.git$/i, ""));
}

/** Extract a pull-request number from a GitHub merge or squash subject. */
function pullRequestNumberFromSubject(subject: string): string | undefined {
  const trimmed = subject.trim();
  const merge = MERGE_PULL_REQUEST.exec(trimmed);
  if (merge) return parsePullRequestNumber(merge[1]!);

  const squash = SQUASH_PULL_REQUEST.exec(trimmed);
  if (squash) return parsePullRequestNumber(squash[1]!);
  return undefined;
}

/**
 * Derive a GitHub pull-request URL from a merge or squash subject and origin.
 *
 * GitHub merge commits start with `Merge pull request #N from`. Squash merges
 * end the subject with `(#N)`. Both need a github.com origin to build a URL.
 */
export function gitHistoryPullRequestUrl(
  commit: Pick<ExtensionVcsHistoryCommit, "subject">,
  repository?: GitHubRepository | null,
): string | undefined {
  if (!repository) return undefined;
  const number = pullRequestNumberFromSubject(commit.subject);
  if (!number) return undefined;
  return `https://github.com/${repository.owner}/${repository.repo}/pull/${number}`;
}
