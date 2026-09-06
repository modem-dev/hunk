import type { ExtensionVcsDiffInput } from "hunkdiff/extension";

/**
 * Describe a diff's comparison in compact range form for titles and Git arguments.
 *
 * This is display text for non-Git backends: Jujutsu and Sapling interpret `..` as a
 * revset rather than Git's direct two-tree comparison, so they must build process
 * arguments from `rangeEndpoints` instead.
 */
export function describeDiffRange(input: ExtensionVcsDiffInput) {
  const endpoints = input.rangeEndpoints;
  return endpoints ? `${endpoints.from}..${endpoints.to}` : input.range;
}

/** Describe the targets using the positional spelling the user supplied. */
export function describeDiffTargets(input: ExtensionVcsDiffInput) {
  const endpoints = input.rangeEndpoints;
  return endpoints ? `${endpoints.from} ${endpoints.to}` : input.range;
}

/** Return whether a VCS diff has any explicit revision or range target. */
export function hasExplicitDiffTarget(input: ExtensionVcsDiffInput) {
  return describeDiffRange(input) !== undefined;
}
