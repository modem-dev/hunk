import {
  HunkExtensionUserError,
  type ExtensionChangeRequestReviewDescriptor,
} from "hunkdiff/extension";
import { parseGitHubRepository } from "./parsing";
import type {
  GitCheckoutIdentity,
  GitHubFetch,
  GitHubRepository,
  ResolvedGitHubPullRequest,
} from "./types";

const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;

/** Builds credential-safe GitHub request headers. */
function githubHeaders(
  env: NodeJS.ProcessEnv,
  userAgent: string,
  accept = "application/vnd.github.v3.diff",
): Headers {
  const headers = new Headers({
    Accept: accept,
    "User-Agent": userAgent,
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (token) {
    try {
      headers.set("Authorization", `Bearer ${token}`);
    } catch {
      throw new HunkExtensionUserError(
        "The configured GitHub token contains characters that cannot be sent in an HTTP header.",
        { suggestions: ["Set GH_TOKEN or GITHUB_TOKEN to the token value without line breaks."] },
      );
    }
  }
  return headers;
}

/** Reads a bounded response body so a remote server cannot exhaust process memory. */
async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
  emptyMessage = "GitHub returned an empty diff.",
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DIFF_BYTES) {
    throw new HunkExtensionUserError("The GitHub diff exceeds the 64 MiB safety limit.");
  }
  if (!response.body) {
    throw new HunkExtensionUserError(emptyMessage);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new HunkExtensionUserError("GitHub diff loading was cancelled.");
      }
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_DIFF_BYTES) {
        await reader.cancel();
        throw new HunkExtensionUserError("The GitHub diff exceeds the 64 MiB safety limit.");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (signal.aborted) {
      throw new HunkExtensionUserError("GitHub diff loading was cancelled.");
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) {
    throw new HunkExtensionUserError(emptyMessage);
  }
  return bytes;
}

/** Converts a non-success PR response into a fixed, credential-safe error. */
function pullRequestResponseError(response: Response, target: ResolvedGitHubPullRequest) {
  const name = `${target.owner}/${target.repo}#${target.number}`;
  if (response.status === 401) {
    return new HunkExtensionUserError(`GitHub rejected the configured token for ${name}.`, {
      suggestions: ["Refresh GH_TOKEN or GITHUB_TOKEN and retry."],
    });
  }
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    return new HunkExtensionUserError(`GitHub API rate limiting blocked ${name}.`, {
      suggestions: [
        "Authenticate with GH_TOKEN or GITHUB_TOKEN, or retry after the rate limit resets.",
      ],
    });
  }
  if (response.status === 403) {
    return new HunkExtensionUserError(`GitHub denied access to ${name}.`, {
      suggestions: ["Check token repository permissions and organization SSO authorization."],
    });
  }
  if (response.status === 404) {
    return new HunkExtensionUserError(
      `GitHub could not find an accessible pull request at ${name}.`,
      {
        suggestions: [
          "Check the repository and PR number; private repositories require token access.",
        ],
      },
    );
  }
  if (response.status >= 300 && response.status < 400) {
    return new HunkExtensionUserError(
      "GitHub redirected the pull-request request; refusing to forward credentials.",
    );
  }
  return new HunkExtensionUserError(`GitHub returned HTTP ${response.status} for ${name}.`);
}

/** Reads a bounded metadata response and rejects malformed payloads. */
async function readPullRequestMetadata(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) {
    throw new HunkExtensionUserError("GitHub PR metadata exceeds the 1 MiB safety limit.");
  }
  if (!response.body) throw new HunkExtensionUserError("GitHub returned empty PR metadata.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new HunkExtensionUserError("GitHub PR discovery was cancelled.");
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_METADATA_BYTES) {
        await reader.cancel();
        throw new HunkExtensionUserError("GitHub PR metadata exceeds the 1 MiB safety limit.");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (signal.aborted) throw new HunkExtensionUserError("GitHub PR discovery was cancelled.");
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HunkExtensionUserError("GitHub returned malformed PR metadata.");
  }
}

/** Finds exactly one accessible open PR associated with the current fork commit. */
export async function findOpenPullRequestForCommit(
  originRepository: GitHubRepository,
  branch: string,
  sha: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
  fetchImpl: GitHubFetch = fetch,
): Promise<ResolvedGitHubPullRequest> {
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new HunkExtensionUserError("The current Git HEAD is not a valid commit SHA.");
  }
  const name = `${originRepository.owner}/${originRepository.repo}:${branch}@${sha.slice(0, 12)}`;
  const url = new URL(
    `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(originRepository.owner)}/${encodeURIComponent(originRepository.repo)}/commits/${sha}/pulls`,
  );
  url.searchParams.set("per_page", "100");

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: githubHeaders(env, "hunk-gh-extension", "application/vnd.github+json"),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (error instanceof HunkExtensionUserError) throw error;
    if (signal.aborted) throw new HunkExtensionUserError("GitHub PR discovery was cancelled.");
    throw new HunkExtensionUserError(
      "GitHub could not be reached while discovering a pull request.",
    );
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new HunkExtensionUserError(`GitHub rejected the configured token for ${name}.`);
    }
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      throw new HunkExtensionUserError(
        `GitHub API rate limiting blocked PR discovery for ${name}.`,
      );
    }
    if (response.status === 403) {
      throw new HunkExtensionUserError(`GitHub denied PR discovery for ${name}.`);
    }
    if (response.status === 404) {
      throw new HunkExtensionUserError(
        `GitHub could not find an accessible commit at ${originRepository.owner}/${originRepository.repo}@${sha}.`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new HunkExtensionUserError(
        "GitHub redirected the PR discovery request; refusing to forward credentials.",
      );
    }
    throw new HunkExtensionUserError(
      `GitHub returned HTTP ${response.status} during PR discovery for ${name}.`,
    );
  }

  const payload = await readPullRequestMetadata(response, signal);
  if (!Array.isArray(payload)) {
    throw new HunkExtensionUserError("GitHub returned malformed PR metadata.");
  }
  const open: ResolvedGitHubPullRequest[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) {
      throw new HunkExtensionUserError("GitHub returned malformed PR metadata.");
    }
    const value = entry as {
      number?: unknown;
      state?: unknown;
      base?: { repo?: { full_name?: unknown } | null } | null;
    };
    if (
      typeof value.number !== "number" ||
      !Number.isSafeInteger(value.number) ||
      value.number <= 0 ||
      (value.state !== "open" && value.state !== "closed")
    ) {
      throw new HunkExtensionUserError("GitHub returned malformed PR metadata.");
    }
    if (value.state === "closed") continue;
    if (typeof value.base?.repo?.full_name !== "string") {
      throw new HunkExtensionUserError("GitHub returned malformed PR metadata.");
    }
    let base: GitHubRepository;
    try {
      base = parseGitHubRepository(value.base.repo.full_name);
    } catch {
      throw new HunkExtensionUserError("GitHub returned malformed PR metadata.");
    }
    open.push({ ...base, number: String(value.number) });
  }

  if (response.headers.get("link")?.includes('rel="next"')) {
    throw new HunkExtensionUserError(
      `GitHub returned paginated PR matches for ${name}, so one pull request cannot be selected safely.`,
      { suggestions: ["Pass the intended pull-request number explicitly."] },
    );
  }
  if (open.length === 0) {
    throw new HunkExtensionUserError(`No accessible open pull request matches ${name}.`, {
      suggestions: ["Pass a pull-request number, owner/repo#number, or URL explicitly."],
    });
  }
  if (open.length > 1) {
    throw new HunkExtensionUserError(`Multiple accessible open pull requests match ${name}.`, {
      suggestions: ["Pass the intended pull-request number explicitly."],
    });
  }
  const { owner, repo, number } = open[0]!;
  return { owner, repo, number };
}

/** Finds a branch PR even when local HEAD is ahead of its pushed upstream tip. */
export async function findOpenPullRequestForBranch(
  originRepository: GitHubRepository,
  checkout: GitCheckoutIdentity,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
  fetchImpl: GitHubFetch = fetch,
): Promise<ResolvedGitHubPullRequest> {
  try {
    return await findOpenPullRequestForCommit(
      originRepository,
      checkout.branch,
      checkout.sha,
      signal,
      env,
      fetchImpl,
    );
  } catch (error) {
    const upstreamSha = checkout.upstreamSha;
    const canRetryPushedTip =
      upstreamSha !== undefined &&
      upstreamSha !== checkout.sha &&
      error instanceof HunkExtensionUserError &&
      (error.message.startsWith("No accessible open pull request") ||
        error.message.startsWith("GitHub could not find an accessible commit"));
    if (!canRetryPushedTip) throw error;
    return findOpenPullRequestForCommit(
      originRepository,
      checkout.branch,
      upstreamSha,
      signal,
      env,
      fetchImpl,
    );
  }
}

/** Parses the validated GitHub fields shown in Hunk's delegated review pane. */
export function parseGitHubPullRequestMetadata(
  value: unknown,
  target: ResolvedGitHubPullRequest,
): ExtensionChangeRequestReviewDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HunkExtensionUserError("GitHub returned malformed pull-request metadata.");
  }
  const candidate = value as Record<string, unknown>;
  const readString = (container: Record<string, unknown>, field: string, maximumBytes: number) => {
    const fieldValue = container[field];
    if (
      typeof fieldValue !== "string" ||
      fieldValue.length === 0 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(fieldValue) ||
      new TextEncoder().encode(fieldValue).byteLength > maximumBytes
    ) {
      throw new HunkExtensionUserError("GitHub returned malformed pull-request metadata.");
    }
    return fieldValue;
  };
  const readObject = (field: string) => {
    const fieldValue = candidate[field];
    if (typeof fieldValue !== "object" || fieldValue === null || Array.isArray(fieldValue)) {
      throw new HunkExtensionUserError("GitHub returned malformed pull-request metadata.");
    }
    return fieldValue as Record<string, unknown>;
  };

  const title = readString(candidate, "title", 2 * 1024);
  const pageUrl = readString(candidate, "html_url", 2 * 1024);
  const author = readString(readObject("user"), "login", 512);
  const base = readString(readObject("base"), "ref", 512);
  const head = readString(readObject("head"), "ref", 512);
  const state = candidate.state;
  const draft = candidate.draft;
  if (
    (state !== "open" && state !== "closed") ||
    (draft !== undefined && typeof draft !== "boolean") ||
    (candidate.merged !== undefined && typeof candidate.merged !== "boolean")
  ) {
    throw new HunkExtensionUserError("GitHub returned malformed pull-request metadata.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(pageUrl);
  } catch {
    throw new HunkExtensionUserError("GitHub returned malformed pull-request metadata.");
  }
  const expectedPath = `/${target.owner}/${target.repo}/pull/${target.number}`.toLowerCase();
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname.toLowerCase() !== "github.com" ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    parsedUrl.pathname.toLowerCase() !== expectedPath
  ) {
    throw new HunkExtensionUserError("GitHub returned malformed pull-request metadata.");
  }

  return {
    kind: "change-request",
    provider: "GitHub",
    title,
    url: pageUrl,
    id: `#${target.number}`,
    repository: `${target.owner}/${target.repo}`,
    author,
    base,
    head,
    state: candidate.merged === true ? "merged" : state,
    ...(typeof draft === "boolean" ? { draft } : {}),
  };
}

/** Fetches bounded GitHub pull-request metadata for delegated review chrome. */
export async function fetchGitHubPullRequestMetadata(
  target: ResolvedGitHubPullRequest,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
  fetchImpl: GitHubFetch = fetch,
): Promise<ExtensionChangeRequestReviewDescriptor> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.number}`,
      {
        headers: githubHeaders(env, "hunk-gh-extension", "application/vnd.github+json"),
        redirect: "manual",
        signal,
      },
    );
  } catch (error) {
    if (error instanceof HunkExtensionUserError) throw error;
    if (signal.aborted)
      throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
    throw new HunkExtensionUserError(
      "GitHub could not be reached while loading pull-request metadata.",
      { suggestions: ["Check network access and retry."] },
    );
  }
  if (!response.ok) throw pullRequestResponseError(response, target);
  return parseGitHubPullRequestMetadata(await readPullRequestMetadata(response, signal), target);
}

/** Fetches one GitHub pull-request diff without invoking the gh CLI. */
export async function fetchGitHubPullRequestDiff(
  target: ResolvedGitHubPullRequest,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
  fetchImpl: GitHubFetch = fetch,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.number}`,
      {
        headers: githubHeaders(env, "hunk-github-pr-extension"),
        redirect: "manual",
        signal,
      },
    );
  } catch (error) {
    if (error instanceof HunkExtensionUserError) throw error;
    if (signal.aborted)
      throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
    throw new HunkExtensionUserError(
      "GitHub could not be reached while loading the pull request.",
      {
        suggestions: ["Check network access and retry."],
      },
    );
  }
  if (!response.ok) throw pullRequestResponseError(response, target);
  return readBoundedResponse(response, signal);
}

/** Fetches one GitHub commit diff without invoking the gh CLI. */
export async function fetchGitHubCommitDiff(
  repository: GitHubRepository,
  sha: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
  fetchImpl: GitHubFetch = fetch,
): Promise<Uint8Array> {
  const name = `${repository.owner}/${repository.repo}@${sha}`;
  let response: Response;
  try {
    response = await fetchImpl(
      `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits/${sha}`,
      { headers: githubHeaders(env, "hunk-gh-extension"), redirect: "manual", signal },
    );
  } catch (error) {
    if (error instanceof HunkExtensionUserError) throw error;
    if (signal.aborted) throw new HunkExtensionUserError("GitHub commit loading was cancelled.");
    throw new HunkExtensionUserError("GitHub could not be reached while loading the commit.");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new HunkExtensionUserError(`GitHub could not find an accessible commit at ${name}.`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new HunkExtensionUserError(
        "GitHub redirected the commit request; refusing to forward credentials.",
      );
    }
    throw new HunkExtensionUserError(`GitHub returned HTTP ${response.status} for ${name}.`);
  }
  return readBoundedResponse(response, signal);
}

/** Fetches the diff between two GitHub refs without invoking the gh CLI. */
export async function fetchGitHubCompareDiff(
  repository: GitHubRepository,
  base: string,
  head: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
  fetchImpl: GitHubFetch = fetch,
): Promise<Uint8Array> {
  const name = `${repository.owner}/${repository.repo}:${base}...${head}`;
  let response: Response;
  try {
    const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    response = await fetchImpl(
      `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/compare/${range}`,
      { headers: githubHeaders(env, "hunk-gh-extension"), redirect: "manual", signal },
    );
  } catch (error) {
    if (error instanceof HunkExtensionUserError) throw error;
    if (signal.aborted)
      throw new HunkExtensionUserError("GitHub comparison loading was cancelled.");
    throw new HunkExtensionUserError("GitHub could not be reached while loading the comparison.");
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new HunkExtensionUserError(`GitHub rejected the configured token for ${name}.`);
    }
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      throw new HunkExtensionUserError(`GitHub API rate limiting blocked ${name}.`);
    }
    if (response.status === 403) {
      throw new HunkExtensionUserError(`GitHub denied access to ${name}.`);
    }
    if (response.status === 404) {
      throw new HunkExtensionUserError(
        `GitHub could not find an accessible comparison at ${name}.`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new HunkExtensionUserError(
        "GitHub redirected the comparison request; refusing to forward credentials.",
      );
    }
    throw new HunkExtensionUserError(`GitHub returned HTTP ${response.status} for ${name}.`);
  }
  return readBoundedResponse(
    response,
    signal,
    `GitHub found no changes between ${base} and ${head}.`,
  );
}
