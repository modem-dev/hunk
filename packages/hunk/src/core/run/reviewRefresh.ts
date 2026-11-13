/**
 * Describes how a mounted review can be rebuilt from its own input.
 *
 * Every deferred refresh — manual reload, watch, extension requests, completed workspace writes —
 * reopens the input the review was loaded from, with the VCS source path for VCS-backed reviews.
 * Stdin-backed inputs are not reloadable because a refresh must not reread consumed stdin. The
 * terminal layers its live view options on top; a headless session uses the input as launched.
 */
import type { CliInput } from "./commandInputs";
import { canReloadInput } from "./inputReload";
import { isVcsReviewInput } from "../vcs";

/** The input and source path a refresh reopens. */
export interface ReviewRefreshRequest {
  nextInput: CliInput;
  sourcePath?: string;
}

/** Derive the refresh request for one input, or null when it cannot be reopened. */
export function deriveReviewRefreshRequest(
  input: CliInput,
  sourceLabel: string,
): ReviewRefreshRequest | null {
  if (!canReloadInput(input)) return null;

  return {
    nextInput: input,
    sourcePath: isVcsReviewInput(input) ? sourceLabel : undefined,
  };
}
