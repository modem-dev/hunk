import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReviewProducer } from "../app/review/producer";
import {
  ReviewReloadCoordinator,
  withReloadVcsCatalog,
  type ReviewReloadAdoption,
} from "../app/session/reloadCoordinator";
import { persistedViewPreferencesFromOptions } from "../core/run/config";
import type { StartupNotice } from "../core/process/startupNotice";
import type { AppBootstrap } from "../core/bootstrap";
import type { CliInput } from "../core/run/commandInputs";
import type { ExtensionSession } from "../extensions/session";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import type { ReloadSessionOptions } from "../session/types";
import type { SendFeedbackImpl } from "./hooks/useFeedbackFormController";
import { App } from "./App";
import { useStartupNotices } from "./hooks/useStartupNotices";
import type {
  WorkspaceFileWriter,
  WorkspaceWriteRunner,
} from "./hooks/useExtensionWorkspaceControls";
import type { WatchedInputRuntime } from "./hooks/useWatchedInput";
import { ThemeController } from "./theme/controller";
import type { PersistedViewPreferences } from "../core/run/config";
import { applySessionViewPreferences } from "./session/viewPreferences";

/**
 * Mount the review a session's reload coordinator publishes, and remount it on every reload.
 *
 * Broker, watch, manual, and post-write refreshes all run through `ReviewReloadCoordinator`
 * (`app/session/reloadCoordinator.ts`), which owns serialization, loading, extension adoption,
 * and broker publication ordering. This host owns the React side of that contract: committing
 * the replacement bootstrap, running the extension lifecycle once the matching App's layout
 * effects have leased controls, live view preferences and theme state that seed retained-launch
 * reloads, startup notices, and quit. App retains interaction state during soft reloads.
 */
export function AppHost({
  bootstrap,
  externalQuitSignal,
  hostClient,
  onQuit = () => process.exit(0),
  onActiveBootstrapChange,
  onFirstFrameReady,
  onViewPreferencesChange,
  returnToSurface,
  initialFilePath,
  sessionCustomThemes,
  retainLaunchConfig = false,
  extensionSession,
  extensionOwnership,
  onRequestSessionShutdown,
  reviewProducer,
  startupNoticeResolver,
  themeController,
  watchRuntime,
  workspaceFileWriter,
  sendFeedback,
  bunVersion = Bun.version,
}: {
  bootstrap: AppBootstrap;
  /** Process and terminal interrupts routed through host-owned extension retirement. */
  externalQuitSignal?: AbortSignal;
  hostClient?: HunkSessionBrokerClient;
  onQuit?: () => void;
  /** Observe the bootstrap after its matching App commit; used by mounted host tests. */
  onActiveBootstrapChange?: (bootstrap: AppBootstrap) => void;
  /** Report once the dynamically mounted review has committed its first requested frame. */
  onFirstFrameReady?: () => void;
  /** Publish live preferences to the owner of a routed review surface. */
  onViewPreferencesChange?: (preferences: PersistedViewPreferences) => void;
  /** Present quit as returning to an owning status or history surface. */
  returnToSurface?: "history" | "status";
  /** Reveal a launch-selected path within the full comparison, only on first mount. */
  initialFilePath?: string;
  /** Keep the owning session's custom palettes across source-target reloads. */
  sessionCustomThemes?: AppBootstrap["customThemes"];
  /** Reload source content without rediscovering a status-owned session's launch configuration. */
  retainLaunchConfig?: boolean;
  /** Session authority shared by every routed surface in this process. */
  extensionSession: ExtensionSession;
  /** Whether this surface may ask the session to adopt a replacement registry. */
  extensionOwnership: "owned" | "borrowed";
  /** Ask the process owner to retire global extension authority before review teardown. */
  onRequestSessionShutdown: () => Promise<void>;
  /**
   * The producer whose generations this host publishes. Supplied by the process that
   * built the initial registration from its first publication; a host mounted without one
   * owns its own, so a headless mount still advances generations across reloads.
   */
  reviewProducer?: ReviewProducer;
  startupNoticeResolver?: () => Promise<StartupNotice | null>;
  /** Session-owned committed theme state shared across routed surfaces. */
  themeController?: ThemeController;
  watchRuntime?: WatchedInputRuntime;
  workspaceFileWriter?: WorkspaceFileWriter;
  /** Send a confirmed feedback submission; tests inject one so they never reach Modem. */
  sendFeedback?: SendFeedbackImpl;
  /** Runtime identity injection for reload compatibility tests. */
  bunVersion?: string;
}) {
  const renderer = useRenderer();
  const initialBootstrap = withReloadVcsCatalog(bootstrap);
  const [ownedThemeController] = useState(
    () =>
      new ThemeController({
        initialTheme: initialBootstrap.initialTheme,
        initialThemeMode: initialBootstrap.initialThemeMode ?? renderer.themeMode,
        customThemes: initialBootstrap.customThemes,
      }),
  );
  const activeThemeController = themeController ?? ownedThemeController;
  // Direct renderer harnesses can mount extension-free bootstraps while still supplying an
  // explicit empty owner. Production startup always attaches the owner's current result.
  const extensionLifecycleEnabled = initialBootstrap.extensions !== undefined;
  const [activeBootstrap, setActiveBootstrap] = useState(initialBootstrap);
  const sessionPreferencesRef = useRef(
    persistedViewPreferencesFromOptions(initialBootstrap.input.options),
  );
  const retainViewPreferences = useCallback(
    (preferences: PersistedViewPreferences) => {
      sessionPreferencesRef.current = preferences;
      onViewPreferencesChange?.(preferences);
    },
    [onViewPreferencesChange],
  );
  const [appVersion, setAppVersion] = useState(0);
  const initialExtensionStartupPendingRef = useRef(true);
  const pendingReloadLifecycleRef = useRef<{
    runMountedLifecycle: () => void;
    resolveMounted: () => void;
  } | null>(null);

  /** Commit one published replacement; resolve once its App has mounted and run the lifecycle. */
  const adoptReload = useCallback(
    (adoption: ReviewReloadAdoption) => {
      const { runMountedLifecycle } = adoption;
      const reloadMounted = runMountedLifecycle
        ? new Promise<void>((resolveMounted) => {
            pendingReloadLifecycleRef.current = { runMountedLifecycle, resolveMounted };
          })
        : undefined;
      activeThemeController.replaceCustomThemes(adoption.customThemes);
      setActiveBootstrap(adoption.bootstrap);
      if (adoption.resetApp) {
        // Bumping the key forces a full App remount. Callers that pass `resetApp: false` get a
        // soft reload that preserves in-memory UI state like selection, filter text, and pane size.
        setAppVersion((current) => current + 1);
      }
      return reloadMounted;
    },
    [activeThemeController],
  );
  const [coordinator] = useState(
    () =>
      new ReviewReloadCoordinator({
        bootstrap: initialBootstrap,
        producer: reviewProducer,
        hostClient,
        extensionSession,
        extensionLifecycleEnabled,
        extensionOwnership,
        retainLaunchConfig,
        sessionCustomThemes,
        bunVersion,
        // Status-owned reviews seed reloads with the session's live preferences and theme.
        retainedLaunchOptions: (launch) =>
          applySessionViewPreferences(launch, {
            ...sessionPreferencesRef.current,
            theme: activeThemeController.getSnapshot().themeId,
          }).input.options,
        adopt: adoptReload,
      }),
  );
  const startupNoticeText = useStartupNotices({
    enabled: !activeBootstrap.input.options.pager,
    notices: activeBootstrap.startupNotices,
    resolver: startupNoticeResolver,
  });

  useLayoutEffect(() => {
    onActiveBootstrapChange?.(activeBootstrap);
  }, [activeBootstrap, onActiveBootstrapChange]);

  useLayoutEffect(() => {
    // Child layout effects run before the parent's, so controls and generation
    // leases are live here; passive UI events still wait until this order lands.
    if (initialExtensionStartupPendingRef.current) {
      initialExtensionStartupPendingRef.current = false;
      coordinator.runInitialLifecycle();
      return;
    }

    const pending = pendingReloadLifecycleRef.current;
    if (!pending) {
      return;
    }
    pendingReloadLifecycleRef.current = null;
    pending.runMountedLifecycle();
    pending.resolveMounted();
  }, [activeBootstrap, coordinator]);

  /** Start one irreversible write atomically with session tracking, unless quit already won. */
  const runWorkspaceWrite = useCallback<WorkspaceWriteRunner>(
    (write) => coordinator.runWorkspaceWrite(write),
    [coordinator],
  );

  /** Serialize broker, watch, workspace, and manual reloads around extension replacement. */
  const reloadSession = useCallback(
    (nextInput: CliInput, options?: ReloadSessionOptions) => coordinator.reload(nextInput, options),
    [coordinator],
  );

  /** Keep the latest mounted refresh descriptor without letting stale cleanup clear its successor. */
  const registerWorkspaceRefreshRequest = useCallback(
    (request: Parameters<ReviewReloadCoordinator["registerRefreshRequest"]>[0]) =>
      coordinator.registerRefreshRequest(request),
    [coordinator],
  );

  /** Reconcile a completed write against whichever review owns the queue when it reaches the front. */
  const reloadAfterWorkspaceWrite = useCallback(
    () => coordinator.reloadAfterWorkspaceWrite(),
    [coordinator],
  );

  /** Coalesce extension requests and resolve their descriptor at the front of the session queue. */
  const requestExtensionReviewReload = useCallback(
    (reviewGeneration: AppBootstrap) => coordinator.requestExtensionReviewReload(reviewGeneration),
    [coordinator],
  );

  /** Revoke all extension authority, finish started writes, then leave. */
  const quitAfterShutdownEvent = useCallback(() => {
    if (!coordinator.beginShutdown()) return;
    queueMicrotask(() => {
      const startedWrites = coordinator.settleStartedWrites();
      void Promise.all([onRequestSessionShutdown(), startedWrites]).finally(onQuit);
    });
  }, [coordinator, onQuit, onRequestSessionShutdown]);

  useEffect(() => {
    if (!externalQuitSignal) return;

    const requestQuit = () => quitAfterShutdownEvent();
    if (externalQuitSignal.aborted) {
      requestQuit();
      return;
    }

    externalQuitSignal.addEventListener("abort", requestQuit, { once: true });
    return () => externalQuitSignal.removeEventListener("abort", requestQuit);
  }, [externalQuitSignal, quitAfterShutdownEvent]);

  return (
    <App
      key={appVersion}
      bootstrap={activeBootstrap}
      canReloadExtensions={extensionOwnership === "owned"}
      hostClient={hostClient}
      noticeText={startupNoticeText}
      onQuit={quitAfterShutdownEvent}
      onFirstFrameReady={onFirstFrameReady}
      onViewPreferencesChange={retainViewPreferences}
      returnToSurface={returnToSurface}
      initialFilePath={initialFilePath}
      onRegisterWorkspaceRefreshRequest={registerWorkspaceRefreshRequest}
      onReloadSession={reloadSession}
      onRequestExtensionReviewReload={requestExtensionReviewReload}
      onWorkspaceWriteCompleted={reloadAfterWorkspaceWrite}
      reviewProducer={coordinator.producer}
      runWorkspaceWrite={runWorkspaceWrite}
      themeController={activeThemeController}
      watchRuntime={watchRuntime}
      workspaceFileWriter={workspaceFileWriter}
      sendFeedback={sendFeedback}
    />
  );
}
