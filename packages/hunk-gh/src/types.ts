export interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface GitHubPullRequestLocator {
  owner?: string;
  repo?: string;
  number: string;
}

export interface GitHubPrInvocation {
  locator?: GitHubPullRequestLocator;
  explicitRepository?: string;
  patchArgs: readonly string[];
  help: boolean;
}

export interface ResolvedGitHubPullRequest extends GitHubRepository {
  number: string;
}

export interface GitCheckoutIdentity {
  branch: string;
  sha: string;
  upstreamSha?: string;
}

export interface GitHubCommitLocator {
  owner?: string;
  repo?: string;
  sha: string;
}

export interface GitHubCommitInvocation {
  locator: GitHubCommitLocator;
  explicitRepository?: string;
  patchArgs: readonly string[];
  help: boolean;
}

export interface GitHubCompareInvocation {
  base: string;
  head: string;
  explicitRepository?: string;
  patchArgs: readonly string[];
  help: boolean;
}

export type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GitHubExtensionRuntime {
  fetchImpl: GitHubFetch;
  env: NodeJS.ProcessEnv;
  resolveOrigin(cwd: string, signal: AbortSignal): Promise<string>;
  resolveCheckout(cwd: string, signal: AbortSignal): Promise<GitCheckoutIdentity>;
  temporaryRoot: string;
}

/** Retains the historical runtime type name for API compatibility. */
export type GitHubPrExtensionRuntime = GitHubExtensionRuntime;
