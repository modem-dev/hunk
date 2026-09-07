import { resolve } from "node:path";
import type { ExtensionReviewDescriptor } from "../extension-api/types";
import { resolveCanonicalPath } from "../core/run/paths";
import type { CliInput } from "../core/run/commandInputs";
import { isVcsReviewInput } from "../core/vcs";

/** Resolve the file identity already used by session reload bounds. */
function patchFileIdentity(input: CliInput, cwd: string): string | undefined {
  if (input.kind !== "patch" || !input.file || input.file === "-") return undefined;
  return resolveCanonicalPath(resolve(cwd, input.file));
}

/** Use the authoritative repository root as stable VCS identity across subdirectory reloads. */
export function reviewDescriptorResourceCwd(
  input: CliInput,
  startupCwd: string,
  repoRoot: string | undefined,
): string {
  return isVcsReviewInput(input) ? (repoRoot ?? startupCwd) : startupCwd;
}

/** Resolve one exact provider review identity used by commits opened from interactive history. */
function historyCommitInputIdentity(input: CliInput, cwd: string): string | undefined {
  const root = resolveCanonicalPath(cwd);
  if (input.kind === "show" && input.ref && !input.pathspecs?.length) {
    return JSON.stringify([root, input.options.vcs ?? null, "show", input.ref]);
  }
  if (input.kind === "vcs" && input.rangeEndpoints && !input.pathspecs?.length) {
    return JSON.stringify([
      root,
      input.options.vcs ?? null,
      "range",
      input.rangeEndpoints.from,
      input.rangeEndpoints.to,
    ]);
  }
  return undefined;
}

/**
 * Preserve review metadata only while reloading the same underlying review resource.
 *
 * File-backed delegated patches use their canonical path. History-selected commits use the exact
 * provider review request so refresh cannot transfer their identity to another revision or backend.
 */
export function reviewDescriptorAfterReload(
  previousInput: CliInput,
  previousCwd: string,
  previousReview: ExtensionReviewDescriptor | undefined,
  nextInput: CliInput,
  nextCwd: string,
): ExtensionReviewDescriptor | undefined {
  if (!previousReview) return undefined;
  const previousPatchIdentity = patchFileIdentity(previousInput, previousCwd);
  if (previousPatchIdentity && previousPatchIdentity === patchFileIdentity(nextInput, nextCwd)) {
    return previousReview;
  }
  if (previousReview.kind !== "commit") return undefined;
  const previousCommitIdentity = historyCommitInputIdentity(previousInput, previousCwd);
  return previousCommitIdentity &&
    previousCommitIdentity === historyCommitInputIdentity(nextInput, nextCwd)
    ? previousReview
    : undefined;
}
