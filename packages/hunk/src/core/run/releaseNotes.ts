/**
 * Builds the hunk.dev changelog URL for one released version.
 *
 * The changelog groups releases into per-minor series pages and marks each release with a stable
 * anchor, so an exact version addresses one entry rather than the top of a page. Both halves of
 * that address are decided by `scripts/generate/generate-changelog.ts`, which renders the pages:
 * the series slug from `minorSeriesOf` and the anchor from `versionAnchor`. The rules are restated
 * here rather than imported because `scripts/` is build tooling the shipped CLI cannot depend on;
 * `releaseNotes.test.ts` pins them against the generator so the two cannot drift apart silently.
 */
import { isComparableVersion } from "./version";

const CHANGELOG_BASE_URL = "https://hunk.dev/changelog";

/**
 * The per-minor series page one version's notes live on: `1.2.3-beta.0` -> `1.2`.
 *
 * Prerelease identifiers are dropped first, so a prerelease lands on the same series page as the
 * stable release it leads to — which is where the generator puts it.
 */
function minorSeriesOf(version: string) {
  const [major = "0", minor = "0"] = version.split("-", 1)[0]?.split(".") ?? [];
  return `${major}.${minor}`;
}

/**
 * The in-page anchor for one release: `0.21.0-beta.0` -> `v0-21-0-beta-0`.
 *
 * Every dot becomes a dash, including those inside a prerelease identifier, and the `v` prefix
 * keeps the id from starting with a digit.
 */
function versionAnchor(version: string) {
  return `v${version.replaceAll(".", "-")}`;
}

/**
 * Return the release-notes URL for one version, or undefined when it has no page to point at.
 *
 * Fails closed on anything that is not a normalized semver — a dev build, a distro-patched string,
 * `0.0.0-unknown` — because a plausible-looking URL to a page that does not exist is worse than
 * printing no link at all.
 */
export function releaseNotesUrl(version: string): string | undefined {
  if (!isComparableVersion(version)) {
    return undefined;
  }

  return `${CHANGELOG_BASE_URL}/${minorSeriesOf(version)}/#${versionAnchor(version)}`;
}
