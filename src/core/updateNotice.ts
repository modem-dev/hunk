import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveHunkStatePath } from "./paths";
import { resolveCliVersion, UNKNOWN_CLI_VERSION } from "./version";

const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/hunkdiff/dist-tags";
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const PRERELEASE_SEMVER_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;
const DEFAULT_UPDATE_NOTICE_FETCH_TIMEOUT_MS = 5_000;
const DISABLE_STARTUP_UPDATE_NOTICE_ENV = "HUNK_DISABLE_UPDATE_NOTICE";
const STARTUP_STATE_VERSION = 1;

interface PersistedStartupState {
  version: number;
  lastSeenCliVersion?: string;
}

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
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  fetchTimeoutMs?: number;
  resolveInstalledVersion?: () => string;
  statePath?: string;
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

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
    },
  };
}

/** Read the persisted startup state from disk, falling back cleanly on missing or invalid files. */
function readPersistedStartupState(path: string): PersistedStartupState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedStartupState>;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : STARTUP_STATE_VERSION,
      lastSeenCliVersion:
        typeof parsed.lastSeenCliVersion === "string" ? parsed.lastSeenCliVersion : undefined,
    };
  } catch {
    return null;
  }
}

/** Persist the current installed CLI version for future upgrade detection. */
function writePersistedStartupState(path: string, installedVersion: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: STARTUP_STATE_VERSION,
        lastSeenCliVersion: installedVersion,
      } satisfies PersistedStartupState,
      null,
      2,
    ),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

/** Return whether the transient startup notice should stay disabled for deterministic sessions like CI. */
function startupUpdateNoticeDisabled(env: NodeJS.ProcessEnv = process.env) {
  return env[DISABLE_STARTUP_UPDATE_NOTICE_ENV] === "1";
}

/** Resolve the one-time copied-skill refresh notice shown after a version change. */
function resolveStartupSkillRefreshNotice(deps: UpdateNoticeDeps = {}): UpdateNotice | null {
  const resolveInstalledVersion = deps.resolveInstalledVersion ?? resolveCliVersion;
  const installedVersion = resolveInstalledVersion();
  if (installedVersion === UNKNOWN_CLI_VERSION) {
    return null;
  }

  const statePath = deps.statePath ?? resolveHunkStatePath(deps.env ?? process.env);
  if (!statePath) {
    return null;
  }

  const previousVersion = readPersistedStartupState(statePath)?.lastSeenCliVersion;

  try {
    writePersistedStartupState(statePath, installedVersion);
  } catch {
    return null;
  }

  if (!previousVersion || previousVersion === installedVersion) {
    return null;
  }

  return {
    key: `skill:${installedVersion}`,
    message: `Hunk ${installedVersion} installed • If your agent copied Hunk's skill, run hunk skill path`,
  };
}

/** Resolve the transient startup notice directly from local state or npm dist-tags. */
export async function resolveStartupUpdateNotice(
  deps: UpdateNoticeDeps = {},
): Promise<UpdateNotice | null> {
  const env = deps.env ?? process.env;
  if (startupUpdateNoticeDisabled(env)) {
    return null;
  }

  const skillRefreshNotice = resolveStartupSkillRefreshNotice(deps);
  if (skillRefreshNotice) {
    return skillRefreshNotice;
  }

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
