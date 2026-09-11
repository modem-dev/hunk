import type { ExtensionVcsHistoryCommit } from "../../extension-api/types";

/** Return a copyable pull-request URL from provider metadata. */
export function resolveHistoryPullRequestUrl(
  commit: ExtensionVcsHistoryCommit,
): string | undefined {
  return commit.pullRequestUrl;
}

/** Format the status-bar confirmation for one copied pull-request URL. */
export function historyPullRequestCopyNotice(url: string): string {
  const match = /\/pull\/(\d+)$/.exec(url);
  if (!match) return "Copied pull request URL";
  return `Copied pull request #${match[1]}`;
}
