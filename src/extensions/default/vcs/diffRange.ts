import type { ExtensionVcsDiffInput } from "hunkdiff/extension";

/**
 * Shared by the bundled Git, Jujutsu, and Sapling backends: each spells a
 * two-commit diff in its own argument syntax, but all three quote the same
 * review back to the user.
 */

/**
 * The compact `A..B` spelling for whatever revisions a review compares.
 *
 * This is display text — review titles, command labels, error messages — and it
 * doubles as the literal argument Git takes, since `git diff A B` and
 * `git diff A..B` are the same request. Backends that read `..` differently
 * (jj and Sapling treat it as a revset) must build their arguments from
 * `rangeEndpoints` instead, and use this only for text a human reads.
 */
export function describeDiffRange(input: ExtensionVcsDiffInput) {
  const endpoints = input.rangeEndpoints;
  return endpoints ? `${endpoints.from}..${endpoints.to}` : input.range;
}

/**
 * The review target exactly as the user spelled it on the command line.
 *
 * Command labels quote the invocation back in error messages, so two endpoints
 * stay two arguments here rather than becoming a range the user never typed.
 */
export function describeDiffTargets(input: ExtensionVcsDiffInput) {
  const endpoints = input.rangeEndpoints;
  return endpoints ? `${endpoints.from} ${endpoints.to}` : input.range;
}
