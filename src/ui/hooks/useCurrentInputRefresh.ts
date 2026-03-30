import { useCallback, useEffect } from "react";
import { canReloadInput, computeWatchSignature } from "../../core/watch";
import type { AppBootstrap, CliInput, LayoutMode } from "../../core/types";
import type { ReloadedSessionResult } from "../../mcp/types";
import { withCurrentViewOptions } from "./useViewPreferences";

interface UseCurrentInputRefreshOptions {
  bootstrap: AppBootstrap;
  layoutMode: LayoutMode;
  onReloadSession: (
    nextInput: CliInput,
    options?: { resetShell?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
  showAgentNotes: boolean;
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  themeId: string;
  wrapLines: boolean;
}

/** Reload the current input while preserving view state, and optionally poll it in watch mode. */
export function useCurrentInputRefresh({
  bootstrap,
  layoutMode,
  onReloadSession,
  showAgentNotes,
  showHunkHeaders,
  showLineNumbers,
  themeId,
  wrapLines,
}: UseCurrentInputRefreshOptions) {
  const canRefreshCurrentInput = canReloadInput(bootstrap.input);
  const watchEnabled = Boolean(bootstrap.input.options.watch && canRefreshCurrentInput);

  const refreshCurrentInput = useCallback(async () => {
    if (!canRefreshCurrentInput) {
      return;
    }

    await onReloadSession(
      withCurrentViewOptions(bootstrap.input, {
        layoutMode,
        themeId,
        showAgentNotes,
        showHunkHeaders,
        showLineNumbers,
        wrapLines,
      }),
      { resetShell: false },
    );
  }, [
    bootstrap.input,
    canRefreshCurrentInput,
    layoutMode,
    onReloadSession,
    showAgentNotes,
    showHunkHeaders,
    showLineNumbers,
    themeId,
    wrapLines,
  ]);

  const triggerRefreshCurrentInput = useCallback(() => {
    void refreshCurrentInput().catch((error) => {
      console.error("Failed to reload the current diff.", error);
    });
  }, [refreshCurrentInput]);

  useEffect(() => {
    if (!watchEnabled) {
      return;
    }

    let cancelled = false;
    let polling = false;
    let refreshing = false;
    let lastSignature: string;

    try {
      lastSignature = computeWatchSignature(bootstrap.input);
    } catch (error) {
      console.error("Failed to initialize watch mode.", error);
      return;
    }

    const pollForChanges = () => {
      if (cancelled || polling || refreshing) {
        return;
      }

      polling = true;
      try {
        const nextSignature = computeWatchSignature(bootstrap.input);
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          refreshing = true;
          void refreshCurrentInput()
            .catch((error) => {
              console.error("Failed to auto-reload the current diff.", error);
            })
            .finally(() => {
              refreshing = false;
            });
        }
      } catch (error) {
        console.error("Failed to poll watch mode input.", error);
      } finally {
        polling = false;
      }
    };

    const interval = setInterval(pollForChanges, 250);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [bootstrap.input, refreshCurrentInput, watchEnabled]);

  return { canRefreshCurrentInput, triggerRefreshCurrentInput };
}
