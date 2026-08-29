import { HunkUserError } from "../run/errors";

// Bun 1.3.14 removes the PathWatcher lock inversion documented in oven-sh/bun#31166.
export const MINIMUM_RELIABLE_WATCH_BUN_VERSION = "1.3.14";

/** Parse the stable numeric prefix Bun reports for release and canary runtimes. */
function parseBunVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) {
    return null;
  }

  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
    prerelease: match[4] !== undefined,
  };
}

/** Return whether one Bun runtime includes the filesystem-watcher deadlock fix. */
export function supportsReliableWatchMode(version: string) {
  const actual = parseBunVersion(version);
  const minimum = parseBunVersion(MINIMUM_RELIABLE_WATCH_BUN_VERSION)!;
  if (!actual) {
    return false;
  }

  for (let index = 0; index < minimum.numbers.length; index += 1) {
    if (actual.numbers[index] !== minimum.numbers[index]) {
      return actual.numbers[index]! > minimum.numbers[index]!;
    }
  }

  return !actual.prerelease;
}

/** Refuse watch mode before an affected Bun runtime can deadlock filesystem watcher cleanup. */
export function assertReliableWatchRuntime(version: string) {
  if (supportsReliableWatchMode(version)) {
    return;
  }

  throw new HunkUserError(
    `Watch mode requires Bun ${MINIMUM_RELIABLE_WATCH_BUN_VERSION} or newer; Bun ${version} can deadlock while closing filesystem watchers.`,
    ["Upgrade Bun with `bun upgrade`, or run Hunk without `--watch`."],
  );
}
