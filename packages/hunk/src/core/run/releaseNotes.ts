/** Builds GitHub release URLs without depending on website publication. */
import { isComparableVersion } from "./version";

const RELEASES_BASE_URL = "https://github.com/modem-dev/hunk/releases/tag";

/** Return the matching release URL, omitting unknown or non-release version strings. */
export function releaseNotesUrl(version: string): string | undefined {
  if (!isComparableVersion(version)) {
    return undefined;
  }

  return `${RELEASES_BASE_URL}/v${version}`;
}
