import { readAppStateRecord, updateAppStateRecord } from "./appStateFile";
import { detectInstallSource, type InstallSource } from "../install/installSource";
import {
  type ChannelVersions,
  fetchChannelVersions,
  type FetchImpl,
  type UpdateChannel,
} from "../install/latestRelease";
import { resolveAppStatePath } from "../run/paths";
import type { StartupNotice } from "./startupNotice";
import {
  isComparableVersion,
  isNewerVersion,
  isStableVersion,
  resolveCliVersion,
  UNKNOWN_CLI_VERSION,
} from "../run/version";

const DISABLE_STARTUP_UPDATE_NOTICE_ENV = "HUNK_DISABLE_UPDATE_NOTICE";
const STARTUP_STATE_VERSION = 1;

interface PersistedStartupState {
  version: number;
  lastSeenCliVersion?: string;
}

export type { InstallSource, UpdateChannel };

/**
 * Install sources Hunk never surfaces an update notice for.
 *
 * mise owns its tool versions: omarchy's `hunk` wrapper runs `mise use -g aqua:modem-dev/hunk`
 * before exec'ing the binary, so the newest release is already installed by the time this session
 * starts. A notice there would ask the user to fix something mise just fixed. A local source build
 * is replaced by rebuilding the checkout it came from, which is the developer's own workflow and
 * not something a published version number should interrupt.
 *
 * Arch packages installed through pacman or an AUR helper are updated externally.
 */
const SILENT_INSTALL_SOURCES: readonly InstallSource[] = ["mise", "pacman", "dev"];

export interface UpdateNoticeDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  fetchTimeoutMs?: number;
  resolveInstalledVersion?: () => string;
  resolveInstallSource?: () => InstallSource;
  resolveExecutablePath?: () => string;
  statePath?: string;
}

/** Return whether the install source manages its own upgrades and needs no update notice. */
function suppressesNotices(installSource: InstallSource) {
  return SILENT_INSTALL_SOURCES.includes(installSource);
}

/**
 * Build the install-aware update instruction shown for one release channel.
 *
 * Sources with no notice at all never reach here; they are filtered out before the release lookup.
 * npm, Homebrew, and curl-installer installs all update in place through `hunk update`, so the
 * notice names that one command; a beta build names the version because `hunk update` alone
 * tracks `latest`.
 */
function updateInstructionForChannel(
  channel: UpdateChannel,
  version: string,
  installSource: InstallSource,
) {
  if (installSource === "nix") {
    return "update Hunk through your Nix configuration";
  }

  return channel === "latest" ? "run `hunk update`" : `run \`hunk update ${version}\``;
}

/** Build the session-local notice payload for the chosen version and channel. */
function createUpdateNotice(
  version: string,
  channel: UpdateChannel,
  installSource: InstallSource,
): StartupNotice {
  const instruction = updateInstructionForChannel(channel, version, installSource);
  return {
    key: `${channel}:${version}`,
    message: `Update available: ${version} (${channel}) • ${instruction}`,
  };
}

/** Choose the single best update notice from the fetched channel versions and installed version. */
function selectUpdateNotice(
  installedVersion: string,
  channelVersions: ChannelVersions,
  installSource: InstallSource,
): StartupNotice | null {
  if (!isComparableVersion(installedVersion)) {
    return null;
  }

  const validLatest = channelVersions.latest;
  // Only npm publishes prereleases, so only npm installs are ever pointed at one.
  const validBeta = installSource === "npm" ? channelVersions.beta : undefined;
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

/** Resolve the transient startup notice from local state and the install source's own registry. */
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

  const resolveInstalledVersion = deps.resolveInstalledVersion ?? resolveCliVersion;
  const resolveInstallSourceImpl =
    deps.resolveInstallSource ??
    (() =>
      detectInstallSource({
        env,
        executablePath: deps.resolveExecutablePath?.(),
        version: resolveInstalledVersion(),
      }));
  const installSource = resolveInstallSourceImpl();
  // Resolved before fetching so silent installs skip the release request entirely.
  if (suppressesNotices(installSource)) {
    return null;
  }

  // A Nix install cannot be updated from a registry, but nixpkgs tracks the npm release stream, so
  // the notice still announces upstream releases and leaves the update to the user's Nix config.
  const lookupSource = installSource === "nix" ? "npm" : installSource;
  const channelVersions = await fetchChannelVersions(lookupSource, {
    fetchImpl: deps.fetchImpl,
    fetchTimeoutMs: deps.fetchTimeoutMs,
  });

  return selectUpdateNotice(resolveInstalledVersion(), channelVersions, installSource);
}
