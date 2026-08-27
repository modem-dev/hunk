import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HunkExtensionUserError,
  type ExtensionCliCommandHandler,
  type ExtensionFactory,
} from "hunkdiff/extension";

const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

export const GITHUB_PR_HELP = `Usage: hunk gh <pull-request> [--repo <owner/repo>] [-- <patch-options...>]

Review a GitHub pull request without requiring the gh CLI.

Pull request forms:
  123                                  infer owner/repo from the local origin
  123 --repo modem-dev/hunk            use an explicit repository
  'modem-dev/hunk#123'                 name the repository and pull request
  https://github.com/modem-dev/hunk/pull/123

Authentication:
  GH_TOKEN, then GITHUB_TOKEN           optional for public repositories
`;

export interface GitHubPullRequestLocator {
  owner?: string;
  repo?: string;
  number: string;
}

export interface GitHubPrInvocation {
  locator: GitHubPullRequestLocator;
  explicitRepository?: string;
  patchArgs: readonly string[];
  help: boolean;
}

export interface ResolvedGitHubPullRequest {
  owner: string;
  repo: string;
  number: string;
}

export type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GitHubPrExtensionRuntime {
  fetchImpl: GitHubFetch;
  env: NodeJS.ProcessEnv;
  resolveOrigin(cwd: string, signal: AbortSignal): Promise<string>;
  temporaryRoot: string;
}

/** Build a user-facing invocation error with the valid forms attached. */
function invocationError(message: string): HunkExtensionUserError {
  return new HunkExtensionUserError(message, {
    suggestions: [
      "Run `hunk gh --help` for accepted pull-request forms.",
      "Use `hunk gh 123 --repo owner/repo` outside a GitHub checkout.",
    ],
  });
}

/** Validate and normalize one positive GitHub pull-request number. */
function parsePullRequestNumber(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw invocationError(`Invalid pull-request number: ${value}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw invocationError(`Pull-request number is too large: ${value}`);
  }
  return String(number);
}

/** Validate and normalize one owner/repository pair. */
export function parseGitHubRepository(value: string): { owner: string; repo: string } {
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !REPOSITORY_PART.test(parts[0]) ||
    !REPOSITORY_PART.test(parts[1]) ||
    parts[0] === "." ||
    parts[0] === ".." ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    throw invocationError(`Invalid GitHub repository: ${value}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Parse one number, owner/repo#number shorthand, or github.com pull-request URL. */
export function parseGitHubPullRequestLocator(value: string): GitHubPullRequestLocator {
  if (/^#?\d+$/.test(value)) {
    return { number: parsePullRequestNumber(value.replace(/^#/, "")) };
  }

  const shorthand = /^([^/#]+\/[^/#]+)#([^#]+)$/.exec(value);
  if (shorthand) {
    const repository = parseGitHubRepository(shorthand[1]!);
    return { ...repository, number: parsePullRequestNumber(shorthand[2]!) };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invocationError(`Invalid GitHub pull-request locator: ${value}`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invocationError("Pull-request URLs must be unmodified https://github.com URLs.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull") {
    throw invocationError("GitHub pull-request URLs must end with /owner/repo/pull/number.");
  }
  const repository = parseGitHubRepository(`${parts[0]}/${parts[1]}`);
  return { ...repository, number: parsePullRequestNumber(parts[3]!) };
}

/** Parse the raw extension-owned tokens without consuming patch options after `--`. */
export function parseGitHubPrInvocation(args: readonly string[]): GitHubPrInvocation {
  const separator = args.indexOf("--");
  const ownedArgs = separator < 0 ? args : args.slice(0, separator);
  const patchArgs = separator < 0 ? [] : args.slice(separator + 1);
  if (ownedArgs.includes("--help") || ownedArgs.includes("-h")) {
    return {
      locator: { number: "1" },
      patchArgs: Object.freeze([...patchArgs]),
      help: true,
    };
  }

  let target: string | undefined;
  let explicitRepository: string | undefined;
  for (let index = 0; index < ownedArgs.length; index += 1) {
    const token = ownedArgs[index]!;
    if (token === "--repo") {
      if (explicitRepository !== undefined) {
        throw invocationError("Specify --repo only once.");
      }
      const value = ownedArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw invocationError("`--repo` requires an owner/repo value.");
      }
      explicitRepository = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--repo=")) {
      if (explicitRepository !== undefined) {
        throw invocationError("Specify --repo only once.");
      }
      explicitRepository = token.slice("--repo=".length);
      if (!explicitRepository) {
        throw invocationError("`--repo` requires an owner/repo value.");
      }
      continue;
    }
    if (token.startsWith("-")) {
      throw invocationError(`Unknown gh option: ${token}`);
    }
    if (target !== undefined) {
      throw invocationError("Specify exactly one pull request.");
    }
    target = token;
  }

  if (!target) {
    throw invocationError("Specify one GitHub pull request.");
  }
  const locator = parseGitHubPullRequestLocator(target);
  if (explicitRepository !== undefined) {
    parseGitHubRepository(explicitRepository);
    if (locator.owner || locator.repo) {
      throw invocationError(
        "Do not combine --repo with a locator that already names a repository.",
      );
    }
  }

  return {
    locator,
    explicitRepository,
    patchArgs: Object.freeze([...patchArgs]),
    help: false,
  };
}

/** Parse a github.com remote URL into its owner and repository. */
export function parseGitHubRemoteRepository(value: string): { owner: string; repo: string } | null {
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
  const withoutSuffix = repositoryPath.replace(/\.git$/i, "");
  try {
    return parseGitHubRepository(withoutSuffix);
  } catch {
    return null;
  }
}

/** Read origin without a shell so repository paths never become executable syntax. */
export async function readGitOrigin(cwd: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
  }

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["remote", "get-url", "origin"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        signal,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (signal.aborted) {
          reject(new HunkExtensionUserError("GitHub pull-request loading was cancelled."));
          return;
        }
        if (error || !stdout.trim()) {
          const unavailable = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
          reject(
            new HunkExtensionUserError(
              unavailable
                ? "Git is unavailable for local origin inference."
                : "The current directory has no small, readable Git origin.",
              {
                suggestions: ["Pass `--repo owner/repo` or use an owner/repo#number locator."],
              },
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** Resolve the repository named by the invocation or inferred from the local origin. */
export async function resolveGitHubPullRequest(
  invocation: GitHubPrInvocation,
  cwd: string,
  signal: AbortSignal,
  resolveOrigin: GitHubPrExtensionRuntime["resolveOrigin"] = readGitOrigin,
): Promise<ResolvedGitHubPullRequest> {
  if (invocation.locator.owner && invocation.locator.repo) {
    return {
      owner: invocation.locator.owner,
      repo: invocation.locator.repo,
      number: invocation.locator.number,
    };
  }
  if (invocation.explicitRepository) {
    return {
      ...parseGitHubRepository(invocation.explicitRepository),
      number: invocation.locator.number,
    };
  }

  const origin = await resolveOrigin(cwd, signal);
  const repository = parseGitHubRemoteRepository(origin);
  if (!repository) {
    throw new HunkExtensionUserError("The local origin is not a supported github.com repository.", {
      suggestions: ["Pass `--repo owner/repo` or use an owner/repo#number locator."],
    });
  }
  return { ...repository, number: invocation.locator.number };
}

/** Read a bounded response body so a remote server cannot exhaust process memory. */
async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DIFF_BYTES) {
    throw new HunkExtensionUserError("The pull-request diff exceeds the 64 MiB safety limit.");
  }
  if (!response.body) {
    throw new HunkExtensionUserError("GitHub returned an empty pull-request response.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
      }
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_DIFF_BYTES) {
        await reader.cancel();
        throw new HunkExtensionUserError("The pull-request diff exceeds the 64 MiB safety limit.");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (signal.aborted) {
      throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
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
    throw new HunkExtensionUserError("GitHub returned an empty pull-request diff.");
  }
  return bytes;
}

/** Convert a non-success GitHub response into a fixed, credential-safe error. */
function githubResponseError(response: Response, target: ResolvedGitHubPullRequest) {
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

/** Fetch one GitHub pull-request diff without invoking the gh CLI. */
export async function fetchGitHubPullRequestDiff(
  target: ResolvedGitHubPullRequest,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: GitHubFetch = fetch,
): Promise<Uint8Array> {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const headers = new Headers({
    Accept: "application/vnd.github.v3.diff",
    "User-Agent": "hunk-github-pr-extension",
    "X-GitHub-Api-Version": "2022-11-28",
  });
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

  const url =
    `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(target.owner)}/` +
    `${encodeURIComponent(target.repo)}/pulls/${target.number}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
    }
    throw new HunkExtensionUserError(
      "GitHub could not be reached while loading the pull request.",
      {
        suggestions: ["Check network access and retry."],
      },
    );
  }
  if (!response.ok) {
    throw githubResponseError(response, target);
  }
  return readBoundedResponse(response, signal);
}

/** Create a temporary patch with restrictive POSIX modes and retain it until shutdown. */
async function writeTemporaryPatch(
  target: ResolvedGitHubPullRequest,
  bytes: Uint8Array,
  temporaryRoot: string,
  retainedDirectories: Set<string>,
): Promise<string> {
  const directory = await mkdtemp(join(temporaryRoot, "hunk-github-pr-"));
  retainedDirectories.add(directory);
  try {
    await chmod(directory, 0o700);
    const safeRepo = target.repo.replace(/[^A-Za-z0-9_.-]/g, "-");
    const patchPath = join(directory, `${safeRepo}-pr-${target.number}.diff`);
    await writeFile(patchPath, bytes, { flag: "wx", mode: 0o600 });
    return patchPath;
  } catch (error) {
    retainedDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Build the GitHub PR extension with injectable runtime boundaries for tests. */
export function createGitHubPrExtension(
  overrides: Partial<GitHubPrExtensionRuntime> = {},
): ExtensionFactory {
  const runtime: GitHubPrExtensionRuntime = {
    fetchImpl: overrides.fetchImpl ?? fetch,
    env: overrides.env ?? process.env,
    resolveOrigin: overrides.resolveOrigin ?? readGitOrigin,
    temporaryRoot: overrides.temporaryRoot ?? tmpdir(),
  };
  const retainedDirectories = new Set<string>();
  let activeRegistries = 0;

  return (hunk) => {
    activeRegistries += 1;
    let retired = false;
    const handler: ExtensionCliCommandHandler = async (args, ctx) => {
      const invocation = parseGitHubPrInvocation(args);
      if (invocation.help) {
        await ctx.stdout.write(GITHUB_PR_HELP);
        return { kind: "exit" };
      }

      const target = await resolveGitHubPullRequest(
        invocation,
        ctx.cwd,
        ctx.signal,
        runtime.resolveOrigin,
      );
      await ctx.stderr.write(
        `Fetching GitHub pull request ${target.owner}/${target.repo}#${target.number}…\n`,
      );
      const diff = await fetchGitHubPullRequestDiff(
        target,
        ctx.signal,
        runtime.env,
        runtime.fetchImpl,
      );
      if (ctx.signal.aborted) {
        throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
      }
      const patchPath = await writeTemporaryPatch(
        target,
        diff,
        runtime.temporaryRoot,
        retainedDirectories,
      );
      const discardPatch = async () => {
        const directory = dirname(patchPath);
        retainedDirectories.delete(directory);
        await rm(directory, { recursive: true, force: true });
      };
      if (ctx.signal.aborted) {
        await discardPatch();
        throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
      }
      await ctx.stderr.write(`Opening ${diff.byteLength.toLocaleString()} bytes in Hunk…\n`);
      if (ctx.signal.aborted) {
        await discardPatch();
        throw new HunkExtensionUserError("GitHub pull-request loading was cancelled.");
      }
      return { kind: "delegate", argv: ["patch", patchPath, ...invocation.patchArgs] };
    };

    hunk.registerCliCommand(
      {
        name: "gh",
        summary: "Review a GitHub pull request",
        usage: "<number|owner/repo#number|pull-request-url> [--repo <owner/repo>]",
      },
      handler,
    );
    hunk.on("shutdown", () => {
      if (retired) return;
      retired = true;
      activeRegistries -= 1;
      if (activeRegistries > 0) return;
      for (const directory of retainedDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
      retainedDirectories.clear();
    });
  };
}

export default createGitHubPrExtension();
