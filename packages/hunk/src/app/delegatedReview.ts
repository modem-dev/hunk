import { resolve } from "node:path";
import type { ExtensionReviewDescriptor } from "../extension-api/types";
import { resolveCanonicalPath } from "../core/run/paths";
import type { CliInput } from "../core/run/commandInputs";

/** Resolve the file identity already used by session reload bounds. */
function patchFileIdentity(input: CliInput, cwd: string): string | undefined {
  if (input.kind !== "patch" || !input.file || input.file === "-") return undefined;
  return resolveCanonicalPath(resolve(cwd, input.file));
}

/**
 * Preserve delegated review metadata only while reloading the same patch resource.
 *
 * The canonical patch path is the reload boundary's existing input identity: changes to the file
 * refresh the same remote review, while a different or non-file input starts an unrelated review.
 */
export function reviewDescriptorAfterReload(
  previousInput: CliInput,
  previousCwd: string,
  previousReview: ExtensionReviewDescriptor | undefined,
  nextInput: CliInput,
  nextCwd: string,
): ExtensionReviewDescriptor | undefined {
  if (!previousReview) return undefined;
  const previousIdentity = patchFileIdentity(previousInput, previousCwd);
  return previousIdentity && previousIdentity === patchFileIdentity(nextInput, nextCwd)
    ? previousReview
    : undefined;
}
