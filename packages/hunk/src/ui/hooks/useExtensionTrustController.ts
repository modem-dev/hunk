/**
 * Decides whether Hunk may load and execute extensions from the current repository.
 *
 * Trusting records permission for future sessions and reloads the current review so the extensions
 * can take effect. Denying records that they must remain disabled. Dismissing the prompt records
 * nothing and keeps it closed for the rest of the session.
 *
 * Pager sessions do not ask. When the current input cannot be reopened, such as stdin, a trust
 * decision takes effect the next time Hunk starts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { writeExtensionTrust, type ExtensionTrustDecision } from "../../extensions/trust";
import type { CurrentReviewRefreshOptions } from "../currentReviewRefresh";
import { nextExtensionTrustPromptRoot } from "../lib/extensionTrustPrompt";

export type ExtensionTrustWriter = (repoRoot: string, decision: ExtensionTrustDecision) => unknown;

export interface ExtensionTrustController {
  extensionTrustPromptOpen: boolean;
  extensionTrustPromptRoot: string | null;
  closeExtensionTrustPrompt: () => void;
  denyRepoExtensions: () => void;
  trustRepoExtensions: () => void;
}

/** Format a persistence failure without allowing an unknown thrown value to escape the UI. */
function trustFailureMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to record the trust decision.";
}

/** Show each repository prompt once and apply the user's decision. */
export function useExtensionTrustController({
  canRefreshCurrentInput,
  pagerMode,
  pendingRepoRoot,
  refreshCurrentInput,
  showNotice,
  writeTrust = writeExtensionTrust,
}: {
  canRefreshCurrentInput: boolean;
  pagerMode: boolean;
  pendingRepoRoot?: string;
  refreshCurrentInput: (options?: CurrentReviewRefreshOptions) => Promise<void>;
  showNotice: (message: string) => void;
  writeTrust?: ExtensionTrustWriter;
}): ExtensionTrustController {
  // Ask about each repository at most once during this Hunk session.
  const [extensionTrustPromptRoot, setExtensionTrustPromptRoot] = useState<string | null>(null);
  const offeredTrustRepoRootsRef = useRef<Set<string>>(new Set());

  // Follow repository changes without reviving a dismissed prompt for an earlier root.
  useEffect(() => {
    const nextRoot = nextExtensionTrustPromptRoot({
      enabled: !pagerMode,
      pendingRepoRoot,
      offeredRepoRoots: offeredTrustRepoRootsRef.current,
    });

    if (nextRoot) {
      offeredTrustRepoRootsRef.current.add(nextRoot);
      setExtensionTrustPromptRoot(nextRoot);
      return;
    }

    // Preserve only the currently eligible question. This also makes StrictMode effect replay a
    // no-op after the first setup records the root as offered.
    setExtensionTrustPromptRoot((currentRoot) =>
      !pagerMode && currentRoot === pendingRepoRoot ? currentRoot : null,
    );
  }, [pagerMode, pendingRepoRoot]);

  // Hide stale state during the render where eligibility changes, before the effect reconciles it.
  const visiblePromptRoot =
    !pagerMode && extensionTrustPromptRoot === pendingRepoRoot ? extensionTrustPromptRoot : null;

  // Dismiss this prompt for the session without recording a decision.
  const closeExtensionTrustPrompt = useCallback(() => {
    setExtensionTrustPromptRoot(null);
  }, []);

  // Persist permission before reloading the review with repo-local extensions enabled.
  const trustRepoExtensions = useCallback(() => {
    const repoRoot = visiblePromptRoot;
    setExtensionTrustPromptRoot(null);
    if (!repoRoot) return;

    try {
      writeTrust(repoRoot, "trusted");
    } catch (error) {
      showNotice(trustFailureMessage(error));
      return;
    }

    if (!canRefreshCurrentInput) {
      showNotice("Trusted this repository • restart Hunk to load its extensions");
      return;
    }

    void refreshCurrentInput({ reason: "manual", reloadExtensions: true }).catch(() => {
      showNotice("Failed to reload after trusting this repository's extensions.");
    });
  }, [canRefreshCurrentInput, refreshCurrentInput, visiblePromptRoot, showNotice, writeTrust]);

  // Persist denial so later sessions do not offer or run this repository's extensions.
  const denyRepoExtensions = useCallback(() => {
    const repoRoot = visiblePromptRoot;
    setExtensionTrustPromptRoot(null);
    if (!repoRoot) return;

    try {
      writeTrust(repoRoot, "denied");
      showNotice("Won't run this repository's extensions");
    } catch (error) {
      showNotice(trustFailureMessage(error));
    }
  }, [showNotice, visiblePromptRoot, writeTrust]);

  return {
    extensionTrustPromptOpen: visiblePromptRoot !== null,
    extensionTrustPromptRoot: visiblePromptRoot,
    closeExtensionTrustPrompt,
    denyRepoExtensions,
    trustRepoExtensions,
  };
}
