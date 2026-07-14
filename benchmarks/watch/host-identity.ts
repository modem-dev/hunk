import { hostname as systemHostname } from "node:os";
import type { WatchHostId } from "./campaign";

interface WatchHostRequirement {
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  hostnameAliases?: string[];
  githubActions?: true;
}

export const WATCH_HOST_REQUIREMENTS: Record<WatchHostId, WatchHostRequirement> = {
  "macos-arm64-aarmstrong": {
    platform: "darwin",
    arch: "arm64",
    hostnameAliases: ["aarmstrong", "aarmstrong.local"],
  },
  "linux-x64-sentry-agent": {
    platform: "linux",
    arch: "x64",
    hostnameAliases: ["sentry-agent"],
  },
  "windows-arm64-hunk-windows": {
    platform: "win32",
    arch: "arm64",
    hostnameAliases: ["hunk-windows"],
  },
  "windows-x64-gha": {
    platform: "win32",
    arch: "x64",
    githubActions: true,
  },
  "macos-arm64-currie": {
    platform: "darwin",
    arch: "arm64",
    hostnameAliases: ["curie", "curie.local", "currie", "currie.local"],
  },
};

/** Prove that a canonical host ID names the current physical host or GitHub runner. */
export function assertWatchHostIdentity(
  hostId: WatchHostId,
  system: {
    platform?: NodeJS.Platform;
    arch?: string;
    hostname?: string;
    env?: Record<string, string | undefined>;
  } = {},
): void {
  const requirement = WATCH_HOST_REQUIREMENTS[hostId];
  const actualPlatform = system.platform ?? process.platform;
  const actualArch = system.arch ?? process.arch;
  const actualHostname = (system.hostname ?? systemHostname()).toLowerCase();
  const environment = system.env ?? process.env;
  if (actualPlatform !== requirement.platform || actualArch !== requirement.arch) {
    throw new Error(
      `${hostId} requires ${requirement.platform}/${requirement.arch}; found ${actualPlatform}/${actualArch}`,
    );
  }
  if (
    requirement.hostnameAliases &&
    !requirement.hostnameAliases.some((alias) => alias.toLowerCase() === actualHostname)
  ) {
    throw new Error(`${hostId} does not match physical hostname ${actualHostname}`);
  }
  if (
    requirement.githubActions &&
    (environment.GITHUB_ACTIONS !== "true" || environment.RUNNER_OS !== "Windows")
  ) {
    throw new Error(`${hostId} requires a Windows GitHub Actions runner`);
  }
}
