/**
 * Decides which GitHub hosts `hunk gh` may contact and where their REST APIs live.
 *
 * The extension sends GH_TOKEN/GITHUB_TOKEN to every request, so only GitHub-operated hosts are
 * accepted: github.com and single-label GitHub Enterprise Cloud tenants (`<tenant>.ghe.com`).
 * GitHub Enterprise Server hosts are deliberately rejected because accepting an arbitrary host
 * from a URL would let a crafted link exfiltrate the token.
 */
import { HunkExtensionUserError } from "hunkdiff/extension";
import { hasControlCharacter } from "./errors";
import type { GitHubRepository } from "./types";

export const DEFAULT_GITHUB_HOST = "github.com";

const GHE_COM_TENANT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/;

/** Returns the canonical lowercase host when it is a supported GitHub host, otherwise null. */
export function normalizeGitHubHost(value: string): string | null {
  const host = value.toLowerCase();
  if (host === DEFAULT_GITHUB_HOST || GHE_COM_TENANT_HOST.test(host)) return host;
  return null;
}

/** Builds the REST API origin for one supported host, re-validating before any token is sent. */
export function githubApiOrigin(host: string): string {
  const normalized = normalizeGitHubHost(host);
  if (normalized !== host) {
    throw new HunkExtensionUserError("Refusing to contact an unsupported GitHub host.");
  }
  return host === DEFAULT_GITHUB_HOST ? "https://api.github.com" : `https://api.${host}`;
}

/** Resolves the host for short forms that name no host, following gh's GH_HOST convention. */
export function resolveDefaultGitHubHost(env: NodeJS.ProcessEnv): string {
  const configured = env.GH_HOST;
  if (!configured) return DEFAULT_GITHUB_HOST;
  const host = normalizeGitHubHost(configured);
  if (host) return host;
  const shown = hasControlCharacter(configured) ? "(contains control characters)" : configured;
  throw new HunkExtensionUserError(`GH_HOST names an unsupported GitHub host: ${shown}`, {
    suggestions: [
      "hunk gh supports github.com and GitHub Enterprise Cloud (<tenant>.ghe.com) hosts.",
      "Unset GH_HOST or pass a full pull-request or commit URL.",
    ],
  });
}

/** Formats owner/repo, prefixed by the host when it is not github.com. */
export function formatGitHubRepository(repository: GitHubRepository): string {
  const path = `${repository.owner}/${repository.repo}`;
  return repository.host === DEFAULT_GITHUB_HOST ? path : `${repository.host}/${path}`;
}
