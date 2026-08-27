/**
 * Coordinates repository-extension trust prompts and decisions for the mounted review.
 *
 * Initial extension discovery and soft reloads can both surface a repository that needs a trust
 * decision. This hook remembers which roots the session already offered, persists trust or denial,
 * and asks the current-review controller to reload newly trusted extensions when possible.
 *
 * App retains dialog rendering and keyboard precedence, while AppHost retains reload authority.
 * Pager sessions never expose the prompt, dismissed roots stay dismissed for the session, and
 * stdin-backed reviews apply a recorded trust grant on the next launch instead of re-reading stdin.
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

/** Own prompt reconciliation and trust-decision side effects for repo-local extensions. */
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
  const [extensionTrustPromptRoot, setExtensionTrustPromptRoot] = useState<string | null>(null);
  const offeredTrustRepoRootsRef = useRef<Set<string>>(new Set());

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

  const closeExtensionTrustPrompt = useCallback(() => {
    setExtensionTrustPromptRoot(null);
  }, []);

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
