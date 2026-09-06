/**
 * Coordinates every in-session refresh of the currently mounted review.
 *
 * Watch changes, manual commands, editor return, extension trust grants, external extension
 * requests, and completed workspace writes converge on the same reloadable review descriptor. This hook derives and registers that
 * descriptor, connects watch notifications to refreshes, and exposes stable refresh callbacks to
 * App.
 *
 * AppHost retains authority over reload serialization, input loading, extension replacement, and
 * bootstrap updates. Requests from this controller use `resetApp: false` so refreshing content
 * preserves mounted UI state such as selection, filters, and pane geometry.
 */

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ReloadContext } from "../../core/bootstrap";
import type { CliInput } from "../../core/run/commandInputs";
import {
  deriveWorkspaceRefreshRequest,
  type CurrentReviewRefreshOptions,
  type CurrentReviewReloadOptions,
  type CurrentReviewViewOptions,
  type WorkspaceRefreshRequest,
} from "../currentReviewRefresh";
import { useWatchedInput, type WatchedInputRuntime } from "./useWatchedInput";

export interface CurrentReviewRefreshController {
  canRefreshCurrentInput: boolean;
  /** Reload with caller-provided provenance while retaining the mounted App. */
  refreshCurrentInput: (options?: CurrentReviewRefreshOptions) => Promise<void>;
  /** Start a user-driven reload and report failures without leaking a rejected promise. */
  triggerRefreshCurrentInput: () => void;
  /** Reload because watch mode observed a source change. */
  refreshWatchedInput: () => Promise<void>;
}

/** Derive, register, and refresh the current mounted review descriptor. */
export function useCurrentReviewRefreshController({
  input,
  onRegisterWorkspaceRefreshRequest,
  onReloadSession,
  onWatchReloadPending,
  reloadContext,
  sourceLabel,
  view,
  watchRuntime,
}: {
  input: CliInput;
  onRegisterWorkspaceRefreshRequest: (request: WorkspaceRefreshRequest) => () => void;
  onReloadSession: (nextInput: CliInput, options?: CurrentReviewReloadOptions) => Promise<unknown>;
  onWatchReloadPending?: () => void;
  reloadContext: ReloadContext;
  sourceLabel: string;
  view: CurrentReviewViewOptions;
  watchRuntime?: WatchedInputRuntime;
}): CurrentReviewRefreshController {
  const request = useMemo(
    () =>
      deriveWorkspaceRefreshRequest({
        input,
        sourceLabel,
        view,
      }),
    [
      input,
      sourceLabel,
      view.layoutMode,
      view.showAgentNotes,
      view.showHunkHeaders,
      view.showLineNumbers,
      view.showMenuBar,
      view.themeId,
      view.wrapLines,
    ],
  );
  const requestRef = useRef(request);
  requestRef.current = request;
  const reloadSessionRef = useRef(onReloadSession);
  reloadSessionRef.current = onReloadSession;

  useLayoutEffect(() => {
    if (!request) return;
    return onRegisterWorkspaceRefreshRequest(request);
  }, [onRegisterWorkspaceRefreshRequest, request]);

  const refreshCurrentInput = useCallback(async (options?: CurrentReviewRefreshOptions) => {
    const currentRequest = requestRef.current;
    if (!currentRequest) return;

    await reloadSessionRef.current(currentRequest.nextInput, {
      ...options,
      resetApp: false,
      sourcePath: currentRequest.sourcePath,
    });
  }, []);

  const triggerRefreshCurrentInput = useCallback(() => {
    void refreshCurrentInput({ reason: "manual" }).catch((error) => {
      console.error("Failed to reload the current diff.", error);
    });
  }, [refreshCurrentInput]);

  const refreshWatchedInput = useCallback(
    () => refreshCurrentInput({ reason: "watch" }),
    [refreshCurrentInput],
  );

  useWatchedInput({
    enabled: Boolean(input.options.watch && request),
    input,
    onReloadPending: onWatchReloadPending,
    refresh: refreshWatchedInput,
    reloadContext,
    runtime: watchRuntime,
  });

  return {
    canRefreshCurrentInput: request !== null,
    refreshCurrentInput,
    triggerRefreshCurrentInput,
    refreshWatchedInput,
  };
}
