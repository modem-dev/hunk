import type { InstallSource } from "./installSource";
import { isPrereleaseVersion, isStableVersion } from "../run/version";

/**
 * Fetches the versions each install channel publishes for Hunk.
 *
 * One lookup per channel, asked of the registry that channel actually installs from: npm reads the
 * `hunkdiff` dist-tags, Homebrew reads its formula API. Channels Hunk cannot update through — Nix,
 * mise, and local source builds — report nothing rather than borrowing another channel's numbers,
 * which is what made Homebrew users see releases `brew` could not yet install.
 */

const NPM_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/hunkdiff/dist-tags";
const HOMEBREW_FORMULA_URL = "https://formulae.brew.sh/api/formula/hunk.json";
const DEFAULT_RELEASE_FETCH_TIMEOUT_MS = 5_000;

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type UpdateChannel = "latest" | "beta";

/** Versions one install source currently publishes, after validation. */
export interface ChannelVersions {
  latest?: string;
  beta?: string;
}

export interface ReleaseLookupDeps {
  fetchImpl?: FetchImpl;
  fetchTimeoutMs?: number;
}

/** Build one fetch timeout signal for a release lookup, if supported by the runtime. */
function createFetchTimeoutSignal(timeoutMs: number) {
  if (typeof AbortController === "undefined") {
    return { signal: undefined, dispose: () => {} };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
    },
  };
}

/** Fetch and parse one JSON document, returning null for any failure or timeout. */
async function fetchJson(url: string, deps: ReleaseLookupDeps): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { signal, dispose } = createFetchTimeoutSignal(
    deps.fetchTimeoutMs ?? DEFAULT_RELEASE_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  } finally {
    dispose();
  }
}

/** Read one string field from an unknown JSON record. */
function readStringField(payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Fetch the `latest` and `beta` dist-tags published for the `hunkdiff` npm package. */
export async function fetchNpmChannelVersions(
  deps: ReleaseLookupDeps = {},
): Promise<ChannelVersions> {
  const payload = await fetchJson(NPM_DIST_TAGS_URL, deps);
  const latest = readStringField(payload, "latest");
  const beta = readStringField(payload, "beta");

  return {
    latest: latest && isStableVersion(latest) ? latest : undefined,
    beta: beta && isPrereleaseVersion(beta) ? beta : undefined,
  };
}

/**
 * Fetch the stable version of the `hunk` formula in homebrew-core.
 *
 * Homebrew has no prerelease channel, so a Homebrew install only ever hears about `latest`.
 */
export async function fetchHomebrewChannelVersions(
  deps: ReleaseLookupDeps = {},
): Promise<ChannelVersions> {
  const payload = await fetchJson(HOMEBREW_FORMULA_URL, deps);
  const versions =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).versions
      : undefined;
  const stable = readStringField(versions, "stable");

  return { latest: stable && isStableVersion(stable) ? stable : undefined };
}

/** Return whether an install source can be updated from a published release at all. */
export function hasPublishedReleases(installSource: InstallSource) {
  return installSource === "npm" || installSource === "homebrew";
}

/** Fetch the versions one install source publishes, asking that channel's own registry. */
export async function fetchChannelVersions(
  installSource: InstallSource,
  deps: ReleaseLookupDeps = {},
): Promise<ChannelVersions> {
  if (installSource === "homebrew") {
    return fetchHomebrewChannelVersions(deps);
  }

  if (installSource === "npm") {
    return fetchNpmChannelVersions(deps);
  }

  // Nix, mise, and source builds install from somewhere Hunk cannot query or act on.
  return {};
}
