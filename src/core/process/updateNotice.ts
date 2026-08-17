import { posix, win32 } from "node:path";
import { readAppStateRecord, updateAppStateRecord } from "./appStateFile";
import { resolveAppStatePath } from "../run/paths";
import type { StartupNotice } from "./startupNotice";
import { resolveCliVersion, UNKNOWN_CLI_VERSION } from "../run/version";

const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/hunkdiff/dist-tags";
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const PRERELEASE_SEMVER_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;
const DEFAULT_UPDATE_NOTICE_FETCH_TIMEOUT_MS = 5_000;
const DISABLE_STARTUP_UPDATE_NOTICE_ENV = "HUNK_DISABLE_UPDATE_NOTICE";
const INSTALL_SOURCE_ENV = "HUNK_INSTALL_SOURCE";
const STARTUP_STATE_VERSION = 1;

interface PersistedStartupState {
  version: number;
  lastSeenCliVersion?: string;
}

export type UpdateChannel = "latest" | "beta";
export type InstallSource = "npm" | "homebrew" | "nix" | "mise";

/**
 * Install sources that upgrade Hunk on their own, so Hunk never surfaces an update notice for them.
 *
 * mise owns its tool versions: omarchy's `hunk` wrapper runs `mise use -g aqua:modem-dev/hunk`
 * before exec'ing the binary, so the newest release is already installed by the time this session
 * starts. A notice there would ask the user to fix something mise just fixed, so suppress rather
 * than swap in a mise-flavored update command.
 */
const SELF_UPDATING_INSTALL_SOURCES: readonly InstallSource[] = ["mise"];

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
  resolveInstallSource?: () => InstallSource;
  resolveExecutablePath?: () => string;
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

/** Split one filesystem path into segments, tolerating either platform's separator. */
function splitPathSegments(candidatePath: string) {
  return candidatePath
    .split(win32.sep)
    .flatMap((segment) => segment.split(posix.sep))
    .filter((segment) => segment.length > 0);
}

/**
 * Return whether this executable lives inside a mise-managed install directory.
 *
 * mise lays every backend out as `<data dir>/mise/installs/<tool>/<version>/<bin>` on all
 * platforms, so the adjacent `mise/installs` segments are the one signal that survives `mise x`
 * (the omarchy wrapper's launch path, which sets none of mise's shell env vars) as well as shims
 * and activated shells.
 */
function isMiseManagedExecutablePath(executablePath: string) {
  const segments = splitPathSegments(executablePath);
  return segments.some(
    (segment, index) => segment === "mise" && segments[index + 1] === "installs",
  );
}

/** Resolve which package manager installed this binary, defaulting to the npm package path. */
function resolveInstallSourceFromRuntime(
  env: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
): InstallSource {
  const installSource = env[INSTALL_SOURCE_ENV];
  if (installSource === "homebrew" || installSource === "nix" || installSource === "mise") {
    return installSource;
  }

  if (executablePath.startsWith("/nix/store/")) {
    return "nix";
  }

  return isMiseManagedExecutablePath(executablePath) ? "mise" : "npm";
}

/** Return whether the install source manages its own upgrades and needs no update notice. */
function managesOwnUpdates(installSource: InstallSource) {
  return SELF_UPDATING_INSTALL_SOURCES.includes(installSource);
}

/**
 * Build the install-aware update instruction shown for one release channel.
 *
 * Self-updating sources never reach here; they are filtered out before the dist-tag lookup.
 */
function updateInstructionForChannel(channel: UpdateChannel, installSource: InstallSource) {
  if (installSource === "homebrew") {
    return "brew update && brew upgrade hunk";
  }

  if (installSource === "nix") {
    return "update Hunk through your Nix configuration";
  }

  return channel === "latest" ? "npm i -g hunkdiff" : "npm i -g hunkdiff@beta";
}

/** Build the session-local notice payload for the chosen version and channel. */
function createUpdateNotice(
  version: string,
  channel: UpdateChannel,
  installSource: InstallSource,
): StartupNotice {
  const instruction = updateInstructionForChannel(channel, installSource);
  return {
    key: `${channel}:${version}`,
    message: `Update available: ${version} (${channel}) • ${instruction}`,
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
  installSource: InstallSource,
): StartupNotice | null {
  if (!isComparableInstalledVersion(installedVersion)) {
    return null;
  }

  const validLatest =
    distTags.latest && isStableVersion(distTags.latest) ? distTags.latest : undefined;
  const validBeta =
    installSource === "npm" && distTags.beta && isPrereleaseVersion(distTags.beta)
      ? distTags.beta
      : undefined;
  const installedIsStable = isStableVersion(installedVersion);

  if (installedIsStable) {
    if (validLatest && isNewerVersion(installedVersion, validLatest)) {
      return createUpdateNotice(validLatest, "latest", installSource);
    }

    if (validBeta && isNewerVersion(installedVersion, validBeta)) {
      return createUpdateNotice(validBeta, "beta", installSource);
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

  return createUpdateNotice(selected.version, selected.channel, installSource);
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
function readPersistedStartupState(path: string): PersistedStartupState {
  const record = readAppStateRecord(path);
  return {
    version: typeof record.version === "number" ? record.version : STARTUP_STATE_VERSION,
    lastSeenCliVersion:
      typeof record.lastSeenCliVersion === "string" ? record.lastSeenCliVersion : undefined,
  };
}

/** Persist the current installed CLI version without discarding unrelated state keys. */
function writePersistedStartupState(path: string, installedVersion: string) {
  updateAppStateRecord(path, {
    version: STARTUP_STATE_VERSION,
    lastSeenCliVersion: installedVersion,
  } satisfies PersistedStartupState);
}

/** Return whether the transient startup notice should stay disabled for deterministic sessions like CI. */
function startupUpdateNoticeDisabled(env: NodeJS.ProcessEnv = process.env) {
  return env[DISABLE_STARTUP_UPDATE_NOTICE_ENV] === "1";
}

/** Resolve the one-time copied-skill refresh notice shown after a version change. */
function resolveStartupSkillRefreshNotice(deps: UpdateNoticeDeps = {}): StartupNotice | null {
  const resolveInstalledVersion = deps.resolveInstalledVersion ?? resolveCliVersion;
  const installedVersion = resolveInstalledVersion();
  if (installedVersion === UNKNOWN_CLI_VERSION) {
    return null;
  }

  const statePath = deps.statePath ?? resolveAppStatePath(deps.env ?? process.env);
  if (!statePath) {
    return null;
  }

  const previousVersion = readPersistedStartupState(statePath).lastSeenCliVersion;

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
): Promise<StartupNotice | null> {
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
  const resolveInstallSource =
    deps.resolveInstallSource ??
    (() => resolveInstallSourceFromRuntime(env, deps.resolveExecutablePath?.()));
  const installSource = resolveInstallSource();
  // Resolved before fetching so self-updating installs skip the dist-tag request entirely.
  if (managesOwnUpdates(installSource)) {
    return null;
  }

  const { signal, dispose } = createFetchTimeoutSignal(fetchTimeoutMs);

  try {
    const response = await fetchImpl(DIST_TAGS_URL, { signal });
    if (!response.ok) {
      return null;
    }

    const parsedPayload = parseDistTags(await response.json());
    return selectUpdateNotice(resolveInstalledVersion(), parsedPayload, installSource);
  } catch {
    return null;
  } finally {
    dispose();
  }
}
