import { execFile } from "node:child_process";
import { HunkExtensionUserError } from "hunkdiff/extension";
import { hasControlCharacter } from "./errors";
import { parseGitHubRepository } from "./parsing";
import type {
  GitCheckoutIdentity,
  GitHubExtensionRuntime,
  GitHubPrInvocation,
  GitHubRepository,
  ResolvedGitHubPullRequest,
} from "./types";

interface GitProcessError extends Error {
  code?: string | number | null;
  killed?: boolean;
}

/** Parses a github.com remote URL into its owner and repository. */
export function parseGitHubRemoteRepository(value: string): GitHubRepository | null {
  const scp = /^(?:[^@\s]+@)?github\.com:([^/\s]+\/[^/\s]+)$/i.exec(value);
  let repositoryPath: string | undefined;
  if (scp) {
    repositoryPath = scp[1];
  } else {
    let url: URL;
    try {
      url = new URL(value);
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
  try {
    return parseGitHubRepository(repositoryPath.replace(/\.git$/i, ""));
  } catch {
    return null;
  }
}

/** Runs one bounded Git query without passing user input through a shell. */
function executeGit(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        signal,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

/** Classifies Git process failures without exposing subprocess internals. */
export function classifyGitLookupFailure(
  error: unknown,
  subject: "origin" | "branch" | "HEAD",
): HunkExtensionUserError {
  const processError = error as GitProcessError | null;
  if (processError?.code === "ENOENT") {
    return new HunkExtensionUserError(`Git is unavailable while reading the current ${subject}.`);
  }
  if (processError?.killed || processError?.code === "ETIMEDOUT") {
    return new HunkExtensionUserError(`Git timed out while reading the current ${subject}.`);
  }
  return new HunkExtensionUserError(`Git failed while reading the current ${subject}.`);
}

/** Reads origin without a shell so repository paths never become executable syntax. */
export async function readGitOrigin(cwd: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted)
    throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
  try {
    const origin = await executeGit(cwd, ["remote", "get-url", "origin"], signal);
    if (!origin) throw new Error("empty origin");
    return origin;
  } catch (error) {
    if (signal.aborted)
      throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
    const processError = error as GitProcessError | null;
    if (processError?.code === "ENOENT") throw classifyGitLookupFailure(error, "origin");
    throw new HunkExtensionUserError("The current checkout has no readable Git origin.", {
      suggestions: ["Pass `--repo owner/repo` or use an owner/repo#number locator."],
    });
  }
}

/** Reads the current branch without a shell and rejects detached HEAD. */
export async function readGitBranch(cwd: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new HunkExtensionUserError("GitHub PR discovery was cancelled.");
  try {
    const branch = await executeGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
    if (!branch) throw new Error("empty branch");
    if (hasControlCharacter(branch)) {
      throw new HunkExtensionUserError(
        "The current Git branch contains terminal control characters and cannot be used for PR discovery.",
      );
    }
    return branch;
  } catch (error) {
    if (signal.aborted) throw new HunkExtensionUserError("GitHub PR discovery was cancelled.");
    if (error instanceof HunkExtensionUserError) throw error;
    const processError = error as GitProcessError | null;
    if (processError?.code === "ENOENT") throw classifyGitLookupFailure(error, "branch");
    if (processError?.code === 1) {
      throw new HunkExtensionUserError(
        "The current checkout has a detached HEAD, so its pull request cannot be inferred.",
        {
          suggestions: [
            "Check out a branch or pass a pull-request number, owner/repo#number, or URL.",
          ],
        },
      );
    }
    throw classifyGitLookupFailure(error, "branch");
  }
}

/** Reads the exact current commit without accepting an ambiguous revision. */
export async function readGitHeadSha(cwd: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new HunkExtensionUserError("GitHub PR discovery was cancelled.");
  try {
    const sha = await executeGit(cwd, ["rev-parse", "--verify", "HEAD"], signal);
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error("invalid HEAD");
    return sha.toLowerCase();
  } catch (error) {
    if (signal.aborted) throw new HunkExtensionUserError("GitHub PR discovery was cancelled.");
    const processError = error as GitProcessError | null;
    if (processError?.code === "ENOENT") throw classifyGitLookupFailure(error, "HEAD");
    throw classifyGitLookupFailure(error, "HEAD");
  }
}

/** Reads the optional pushed upstream commit without requiring every branch to track one. */
async function readGitUpstreamSha(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const sha = await executeGit(cwd, ["rev-parse", "--verify", "@{upstream}"], signal);
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : undefined;
  } catch (error) {
    if (signal.aborted) throw new HunkExtensionUserError("GitHub PR discovery was cancelled.");
    const processError = error as GitProcessError | null;
    if (processError?.code === "ENOENT") throw classifyGitLookupFailure(error, "HEAD");
    return undefined;
  }
}

/** Reads the branch, local HEAD, and optional pushed tip needed for fork-aware PR discovery. */
export async function readGitCheckout(
  cwd: string,
  signal: AbortSignal,
): Promise<GitCheckoutIdentity> {
  const branch = await readGitBranch(cwd, signal);
  const [sha, upstreamSha] = await Promise.all([
    readGitHeadSha(cwd, signal),
    readGitUpstreamSha(cwd, signal),
  ]);
  return { branch, sha, ...(upstreamSha === undefined ? {} : { upstreamSha }) };
}

/** Resolves an explicit repository or infers one from the local GitHub origin. */
export async function resolveGitHubRepository(
  explicitRepository: string | undefined,
  cwd: string,
  signal: AbortSignal,
  resolveOrigin: GitHubExtensionRuntime["resolveOrigin"] = readGitOrigin,
): Promise<GitHubRepository> {
  if (explicitRepository) return parseGitHubRepository(explicitRepository);
  const repository = parseGitHubRemoteRepository(await resolveOrigin(cwd, signal));
  if (!repository) {
    throw new HunkExtensionUserError("The local origin is not a supported github.com repository.", {
      suggestions: ["Pass `--repo owner/repo` explicitly."],
    });
  }
  return repository;
}

/** Resolves the repository named by a PR invocation or inferred from local origin. */
export async function resolveGitHubPullRequest(
  invocation: GitHubPrInvocation,
  cwd: string,
  signal: AbortSignal,
  resolveOrigin: GitHubExtensionRuntime["resolveOrigin"] = readGitOrigin,
): Promise<ResolvedGitHubPullRequest> {
  if (!invocation.locator) {
    throw new HunkExtensionUserError("A pull-request locator is required for direct resolution.");
  }
  if (invocation.locator.owner && invocation.locator.repo) {
    return {
      owner: invocation.locator.owner,
      repo: invocation.locator.repo,
      number: invocation.locator.number,
    };
  }
  const repository = await resolveGitHubRepository(
    invocation.explicitRepository,
    cwd,
    signal,
    resolveOrigin,
  );
  return { ...repository, number: invocation.locator.number };
}
