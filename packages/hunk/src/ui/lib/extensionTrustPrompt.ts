/**
 * Which repo root, if any, the extension trust prompt should be asking about.
 *
 * The pending root is not a launch-time constant: a session reload can load
 * extensions for a different working directory while the app stays mounted, so
 * prompt visibility is derived from the current pending root rather than
 * captured once. Roots already offered this session are remembered so that
 * dismissing with "not now" stays dismissed until the repo under review
 * actually changes — an answer, not a value, is what closes the prompt.
 */
export interface ExtensionTrustPromptInput {
  /** False in pager mode, where Hunk owns the screen for piped output instead. */
  enabled: boolean;
  /** Repo root whose extensions were skipped for want of a trust decision. */
  pendingRepoRoot: string | null | undefined;
  /** Repo roots this session has already put in front of the user. */
  offeredRepoRoots: ReadonlySet<string>;
}

/**
 * Decide the repo root to prompt for, or null to leave the prompt closed.
 *
 * Callers record the returned root as offered before opening, so the next
 * derivation for the same root is a no-op.
 */
export function nextExtensionTrustPromptRoot({
  enabled,
  pendingRepoRoot,
  offeredRepoRoots,
}: ExtensionTrustPromptInput): string | null {
  if (!enabled || !pendingRepoRoot || offeredRepoRoots.has(pendingRepoRoot)) {
    return null;
  }

  return pendingRepoRoot;
}
