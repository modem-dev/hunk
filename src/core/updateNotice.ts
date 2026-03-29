import { resolveCliVersion } from "./version";

const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/hunkdiff/dist-tags";
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const PRERELEASE_SEMVER_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;
const UNKNOWN_CLI_VERSION = "0.0.0-unknown";
const DEFAULT_UPDATE_NOTICE_FETCH_TIMEOUT_MS = 5_000;

export type UpdateChannel = "latest" | "beta";

export interface UpdateNotice {
  key: string;
  message: string;
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ParsedDistTags {
  latest?: string;
  beta?: string;
}

export interface UpdateNoticeDeps {
  fetchImpl?: FetchImpl;
  fetchTimeoutMs?: number;
  resolveInstalledVersion?: () => string;
}

/** Return whether one version string is a normalized stable semver. */
function isStableVersion(version: string) {
  return STABLE_SEMVER_PATTERN.test(version);
}

/** Return whether one version string looks like a prerelease semver. */
function isPrereleaseVersion(version: string) {
  return PRERELEASE_SEMVER_PATTERN.test(version);
}

/** Parse only the dist-tags that participate in startup update notices. */
function parseDistTags(payload: unknown): ParsedDistTags {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {};
  }

  const record = payload as Record<string, unknown>;
  return {
    latest: typeof record.latest === "string" ? record.latest : undefined,
    beta: typeof record.beta === "string" ? record.beta : undefined,
  };
}

/** Compare two versions and return whether the candidate is strictly newer. */
function isNewerVersion(current: string, candidate: string) {
  try {
    return Bun.semver.order(current, candidate) < 0;
  } catch {
    return false;
  }
}

/** Build the install command shown in the transient notice for one channel. */
function commandForChannel(channel: UpdateChannel) {
  return channel === "latest" ? "npm i -g hunkdiff" : "npm i -g hunkdiff@beta";
}

/** Build the session-local notice payload for the chosen version and channel. */
function createUpdateNotice(version: string, channel: UpdateChannel): UpdateNotice {
  const command = commandForChannel(channel);
  return {
    key: `${channel}:${version}`,
    message: `Update available: ${version} (${channel}) • ${command}`,
  };
}

/** Return whether the installed version can participate in update comparisons. */
function isComparableInstalledVersion(version: string) {
  if (version === UNKNOWN_CLI_VERSION) {
    return false;
  }

  return isStableVersion(version) || isPrereleaseVersion(version);
}

/** Choose the single best update notice from the fetched dist-tags and installed version. */
function selectUpdateNotice(
  installedVersion: string,
  distTags: ParsedDistTags,
): UpdateNotice | null {
  if (!isComparableInstalledVersion(installedVersion)) {
    return null;
  }

  const validLatest =
    distTags.latest && isStableVersion(distTags.latest) ? distTags.latest : undefined;
  const validBeta = distTags.beta && isPrereleaseVersion(distTags.beta) ? distTags.beta : undefined;
  const installedIsStable = isStableVersion(installedVersion);

  if (installedIsStable) {
    if (validLatest && isNewerVersion(installedVersion, validLatest)) {
      return createUpdateNotice(validLatest, "latest");
    }

    if (validBeta && isNewerVersion(installedVersion, validBeta)) {
      return createUpdateNotice(validBeta, "beta");
    }

    return null;
  }

  const newerCandidates: Array<{ channel: UpdateChannel; version: string }> = [];
  if (validLatest && isNewerVersion(installedVersion, validLatest)) {
    newerCandidates.push({ channel: "latest", version: validLatest });
  }

  if (validBeta && isNewerVersion(installedVersion, validBeta)) {
    newerCandidates.push({ channel: "beta", version: validBeta });
  }

  if (newerCandidates.length === 0) {
    return null;
  }

  const selected = newerCandidates.reduce((best, candidate) =>
    isNewerVersion(best.version, candidate.version) ? candidate : best,
  );

  return createUpdateNotice(selected.version, selected.channel);
}

/** Build one fetch timeout signal for the dist-tag lookup, if supported by the runtime. */
function createFetchTimeoutSignal(timeoutMs: number) {
  if (typeof AbortController === "undefined") {
    return { signal: undefined, dispose: () => {} };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
    },
  };
}

/** Resolve the transient startup notice directly from npm dist-tags without persisted state. */
export async function resolveStartupUpdateNotice(
  deps: UpdateNoticeDeps = {},
): Promise<UpdateNotice | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_UPDATE_NOTICE_FETCH_TIMEOUT_MS;
  const resolveInstalledVersion = deps.resolveInstalledVersion ?? resolveCliVersion;
  const { signal, dispose } = createFetchTimeoutSignal(fetchTimeoutMs);

  try {
    const response = await fetchImpl(DIST_TAGS_URL, { signal });
    if (!response.ok) {
      return null;
    }

    const parsedPayload = parseDistTags(await response.json());
    return selectUpdateNotice(resolveInstalledVersion(), parsedPayload);
  } catch {
    return null;
  } finally {
    dispose();
  }
}
