/** Commit fields shared by provider history records and direct review metadata. */
export interface VcsReviewCommit {
  revisionId: string;
  displayId: string;
  subject: string;
  authorName: string;
  authorEmail?: string;
  authoredAt: string;
}

/** Remove terminal controls and collapse one provider field to a display-safe line. */
function sanitizeReviewText(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Truncate one field without splitting Unicode code points or exceeding transport bytes. */
function truncateReviewText(value: string, maxBytes: number) {
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of sanitizeReviewText(value)) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Resolve the same offline account-like author label used by interactive history. */
export function vcsReviewAuthorLabel(commit: VcsReviewCommit) {
  const email = commit.authorEmail?.trim();
  if (email) {
    const github = email.match(/^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i);
    if (github?.[1]) return github[1];
    const separator = email.indexOf("@");
    if (separator > 0) return email.slice(0, separator);
  }
  return commit.authorName;
}

/** Build bounded metadata for one directly reviewed commit. */
export function commitReviewInfo(provider: string, commit: VcsReviewCommit) {
  const authoredAt = Number.isNaN(Date.parse(commit.authoredAt)) ? undefined : commit.authoredAt;
  return {
    kind: "commit" as const,
    provider: truncateReviewText(provider, 256),
    title: truncateReviewText(commit.subject, 2 * 1024) || "(no commit message)",
    revision: truncateReviewText(commit.revisionId, 512),
    displayRevision: truncateReviewText(commit.displayId, 64),
    author: truncateReviewText(vcsReviewAuthorLabel(commit), 512) || "Unknown author",
    ...(authoredAt === undefined ? {} : { authoredAt }),
  };
}

/** Build bounded newest-first metadata for one direct revision comparison. */
export function comparisonReviewInfo(
  provider: string,
  base: string,
  head: string,
  commits: readonly VcsReviewCommit[],
  commitCount?: number,
) {
  const rows = commits.slice(0, 8).map((commit) => ({
    title: truncateReviewText(commit.subject, 128) || "(no commit message)",
    author: truncateReviewText(vcsReviewAuthorLabel(commit), 64) || "Unknown author",
    ...(Number.isNaN(Date.parse(commit.authoredAt)) ? {} : { authoredAt: commit.authoredAt }),
    revision: truncateReviewText(commit.revisionId, 512),
    displayRevision: truncateReviewText(commit.displayId, 64),
  }));
  return {
    kind: "comparison" as const,
    provider: truncateReviewText(provider, 256),
    title:
      commitCount === undefined
        ? "Commit comparison"
        : `${commitCount} commit${commitCount === 1 ? "" : "s"}`,
    base: truncateReviewText(base, 512),
    head: truncateReviewText(head, 512),
    ...(commitCount === undefined ? {} : { commitCount }),
    ...(rows.length === 0 ? {} : { commits: rows }),
  };
}
