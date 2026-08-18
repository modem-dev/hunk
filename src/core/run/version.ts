import packageJson from "../../../package.json" with { type: "json" };

export const UNKNOWN_CLI_VERSION = "0.0.0-unknown";

const PACKAGE_CLI_VERSION = packageJson.version;
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const PRERELEASE_SEMVER_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;

/** Resolve the CLI version reported by `hunk --version`. */
export function resolveCliVersion(): string {
  if (typeof PACKAGE_CLI_VERSION !== "string" || PACKAGE_CLI_VERSION.length === 0) {
    return UNKNOWN_CLI_VERSION;
  }

  return PACKAGE_CLI_VERSION;
}

/** Return whether one version string is a normalized stable semver. */
export function isStableVersion(version: string) {
  return STABLE_SEMVER_PATTERN.test(version);
}

/** Return whether one version string looks like a prerelease semver. */
export function isPrereleaseVersion(version: string) {
  return PRERELEASE_SEMVER_PATTERN.test(version);
}

/** Return whether the installed version can participate in update comparisons. */
export function isComparableVersion(version: string) {
  if (version === UNKNOWN_CLI_VERSION) {
    return false;
  }

  return isStableVersion(version) || isPrereleaseVersion(version);
}

/** Compare two versions and return whether the candidate is strictly newer. */
export function isNewerVersion(current: string, candidate: string) {
  try {
    return Bun.semver.order(current, candidate) < 0;
  } catch {
    return false;
  }
}
