/**
 * Minimal GitHub CLI bridge used by `hunk diff --pr`.
 *
 * Hunk stays a local diff viewer; it does not talk to the GitHub API itself.
 * Instead it shells out to the user's authenticated `gh` and reuses the
 * existing patch pipeline, so a pull request becomes just another patch source.
 */

/** One resolved pull request patch, ready to feed the patch loader. */
export interface PullRequestPatch {
  /** Unified diff text produced by `gh pr diff --patch`. */
  text: string;
  /** Human-readable label such as `PR #68` shown in the review header. */
  label: string;
}

/** Raised when `gh` is unavailable or the pull request cannot be fetched. */
export class GitHubCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubCliError";
  }
}

/** Normalize a `--pr` value into the label shown in the review header. */
function describePullRequest(ref: string): string {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    return `PR #${trimmed}`;
  }

  return `PR ${trimmed}`;
}

/**
 * Fetch one pull request as a unified diff via `gh pr diff <ref> --patch`.
 *
 * `ref` accepts anything `gh` accepts: a PR number, URL, or branch name.
 * `repo` maps to `gh --repo <owner/repo>`; when omitted `gh` resolves the
 * repository from the current directory.
 */
export async function fetchPullRequestPatch(
  ref: string,
  repo?: string,
  ghExecutable = "gh",
): Promise<PullRequestPatch> {
  const args = ["pr", "diff", ref, "--patch"];
  if (repo) {
    args.push("--repo", repo);
  }

  let proc: Bun.ReadableSubprocess;
  try {
    proc = Bun.spawn([ghExecutable, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new GitHubCliError(
      "`hunk diff --pr` requires the GitHub CLI (gh). Install it from https://cli.github.com and run `gh auth login`.",
    );
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim() || `gh exited with code ${exitCode}`;
    throw new GitHubCliError(`Failed to fetch ${describePullRequest(ref)} via gh: ${detail}`);
  }

  if (stdout.trim().length === 0) {
    throw new GitHubCliError(`${describePullRequest(ref)} has no diff to review.`);
  }

  return { text: stdout, label: describePullRequest(ref) };
}
