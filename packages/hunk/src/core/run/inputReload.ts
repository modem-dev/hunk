/**
 * Whether a session can rebuild its review without rereading stdin.
 *
 * Its own module rather than a corner of `watch.ts`: watching is the loudest
 * consumer, but the same question gates the refresh key and — because a
 * workspace write is only honest if the review can catch up with it — the
 * extension workspace write policy. Kept free of `node:fs` and of the VCS
 * signature machinery so those callers can ask it without pulling either in.
 */

import type { CliInput } from "./commandInputs";

/** Return whether the current input can be rebuilt from files or VCS state without rereading stdin. */
export function canReloadInput(input: CliInput) {
  if (input.options.agentContext === "-") {
    return false;
  }

  return input.kind !== "patch" || Boolean(input.file && input.file !== "-");
}
