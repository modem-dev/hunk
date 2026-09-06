import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveConfiguredExtensions } from "../app/extensionBootstrap";
import { ReviewProducer } from "../app/review/producer";
import { reviewDescriptorAfterReload } from "../app/delegatedReview";
import { loadConfiguredSessionBootstrap } from "../app/sessionBootstrap";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { restoreFileLanguageRegistrations } from "../core/changeset/fileLanguage";
import { resolveConfiguredCliInput } from "../core/run/config";
import { resolveRuntimeCliInput } from "../core/process/terminal";
import type { StartupNotice } from "../core/process/startupNotice";
import type { AppBootstrap } from "../core/bootstrap";
import type { CliInput } from "../core/run/commandInputs";
import type { ExtensionReviewReloadResult } from "../extension-api/types";
import type { ExtensionLoadResult } from "../extensions/types";
import {
  createUnknownVcsNotice,
  reportExtensionApplyIssues,
  resolveExtensionVcsAdapters,
} from "../extensions/apply";
import { emitExtensionEvent } from "../extensions/events";
import type { ExtensionSession } from "../extensions/session";
import { extendVcsCatalog } from "../core/vcs";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../app/session/registration";
import {
  createSessionReloadBounds,
  validateSessionReloadWithinBounds,
} from "../app/session/reloadBounds";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import type { ReloadSessionOptions } from "../session/types";
import { App } from "./App";
import type { WorkspaceRefreshRequest } from "./currentReviewRefresh";
import { useStartupNotices } from "./hooks/useStartupNotices";
import type {
  WorkspaceFileWriter,
  WorkspaceWriteRunner,
} from "./hooks/useExtensionWorkspaceControls";
import { assertReliableWatchRuntime } from "../core/watch/runtime";
import type { WatchedInputRuntime } from "./hooks/useWatchedInput";

/** Build the stable refusal returned once quit becomes terminal for reload coordination. */
function reloadRefusedDuringShutdown() {
  return new Error("The review session is shutting down and cannot reload.");
}

/** Describe a host reload failure without assuming it is an Error instance. */
function describeExtensionReloadFailure(error: unknown) {
  const detail = error instanceof Error ? error.message || error.name : String(error);
  return `Failed to reload the current review: ${detail}`;
}

/** Keep one live Hunk app mounted while allowing daemon-driven session reloads. */
export function AppHost({
  bootstrap,
  externalQuitSignal,
  hostClient,
  onQuit = () => process.exit(0),
  onActiveBootstrapChange,
  onFirstFrameReady,
  returnToHistory = false,
  extensionSession,
  extensionOwnership,
  onRequestSessionShutdown,
  reviewProducer,
  startupNoticeResolver,
  watchRuntime,
  workspaceFileWriter,
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
  /** Present quit as returning to an owning history surface. */
  returnToHistory?: boolean;
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
  watchRuntime?: WatchedInputRuntime;
  workspaceFileWriter?: WorkspaceFileWriter;
  /** Runtime identity injection for reload compatibility tests. */
  bunVersion?: string;
}) {
  const initialBootstrap = bootstrap.reloadContext.vcsCatalog
    ? bootstrap
    : {
        ...bootstrap,
        reloadContext: {
          ...bootstrap.reloadContext,
          vcsCatalog: getBundledVcsCatalog(),
        },
      };
  const [activeExtensionSession] = useState(extensionSession);
  // Direct renderer harnesses can mount extension-free bootstraps while still supplying an
  // explicit empty owner. Production startup always attaches the owner's current result.
  const extensionLifecycleEnabled = initialBootstrap.extensions !== undefined;
  const [activeBootstrap, setActiveBootstrap] = useState(initialBootstrap);
  const reviewIdentityRef = useRef({
    input: initialBootstrap.input,
    cwd: initialBootstrap.reloadContext.cwd,
    review: initialBootstrap.review,
  });
  const [producer] = useState(
    () =>
      reviewProducer ??
      new ReviewProducer({
        files: initialBootstrap.changeset.files,
        sourceLabel: initialBootstrap.changeset.sourceLabel,
      }),
  );
  const [appVersion, setAppVersion] = useState(0);
  // Experimental capabilities are launch authority: remote/watch reloads may replace content,
  // but opting in or out requires starting a new Hunk process.
  const launchExperimental = initialBootstrap.input.options.experimental === true;
  const launchFast = initialBootstrap.input.options.fast === true;
  // Extension authority is launch authority for the same reason. A reload command
  // names *content* to reopen — `hunk session reload <id> -- diff` — and is parsed
  // fresh, so it carries none of the extension flags the session was launched
  // with. Without re-threading them, `--no-extensions` silently stops applying on
  // the first reload (extensions the user disabled start executing again) and
  // `--extension` paths silently stop loading. Both are captured raw: `undefined`
  // means "no flag given", which must keep deferring to the config layers rather
  // than becoming an explicit choice.
  const launchExtensionsEnabled = initialBootstrap.input.options.extensions;
  const launchExtensionPaths = initialBootstrap.input.options.extensionPaths;
  const [sessionFileBounds] = useState(() =>
    createSessionReloadBounds(initialBootstrap, { cwd: initialBootstrap.reloadContext.cwd }),
  );
  const initialExtensionStartupPendingRef = useRef(true);
  const reloadTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingExtensionReloadRef = useRef<{
    reviewGeneration: AppBootstrap;
    promise: Promise<ExtensionReviewReloadResult>;
  } | null>(null);
  const quitRequestedRef = useRef(false);
  const pendingWorkspaceWritesRef = useRef<Set<Promise<void>>>(new Set());
  const workspaceRefreshRequestRef = useRef<WorkspaceRefreshRequest | undefined>(undefined);
  const pendingReloadLifecycleRef = useRef<{
    extensions: ExtensionLoadResult;
    cwd: string;
    changeset: AppBootstrap["changeset"];
    reason: NonNullable<ReloadSessionOptions["reason"]>;
    emitStartup: boolean;
    resolveMounted: () => void;
  } | null>(null);
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
      if (extensionLifecycleEnabled && extensionOwnership === "owned") {
        activeExtensionSession.startCurrent(initialBootstrap.reloadContext.cwd);
      }
      emitExtensionEvent(
        extensionLifecycleEnabled ? activeExtensionSession.current : undefined,
        "changeset_loaded",
        {
          changeset: initialBootstrap.changeset,
        },
      );
      return;
    }

    const pending = pendingReloadLifecycleRef.current;
    if (!pending) {
      return;
    }
    pendingReloadLifecycleRef.current = null;
    if (pending.emitStartup) {
      activeExtensionSession.startCurrent(pending.cwd);
    }
    emitExtensionEvent(pending.extensions, "changeset_loaded", {
      changeset: pending.changeset,
    });
    emitExtensionEvent(pending.extensions, "session_reload", {
      changeset: pending.changeset,
      reason: pending.reason,
    });
    pending.resolveMounted();
  }, [
    activeBootstrap,
    extensionLifecycleEnabled,
    extensionOwnership,
    activeExtensionSession,
    initialBootstrap.reloadContext.cwd,
  ]);

  /** Start one irreversible write atomically with host tracking, unless quit already won. */
  const runWorkspaceWrite = useCallback<WorkspaceWriteRunner>(async (write) => {
    if (quitRequestedRef.current) return false;
    const pending = write();
    pendingWorkspaceWritesRef.current.add(pending);
    try {
      await pending;
      return true;
    } finally {
      pendingWorkspaceWritesRef.current.delete(pending);
    }
  }, []);

  const performReloadSession = useCallback(
    async (nextInput: CliInput, options?: ReloadSessionOptions) => {
      if (quitRequestedRef.current) throw reloadRefusedDuringShutdown();

      // Re-run the same startup normalization pipeline used on first launch so reloads honor
      // runtime defaults and config layering instead of assuming `nextInput` is already final.
      // `sourcePath` matters for daemon-driven reloads that ask Hunk to reopen content from a
      // different working directory than the process originally started in.
      const runtimeInput = resolveRuntimeCliInput({
        ...nextInput,
        options: {
          ...nextInput.options,
          experimental: launchExperimental,
          fast: launchFast,
          extensions: launchExtensionsEnabled,
          extensionPaths: launchExtensionPaths,
        },
      });
      const { cwd } = validateSessionReloadWithinBounds(sessionFileBounds, runtimeInput, {
        sourcePath: options?.sourcePath,
      });
      const baseVcsCatalog = getBundledVcsCatalog();
      const currentExtensions = extensionLifecycleEnabled
        ? activeExtensionSession.current
        : undefined;
      const currentAdapters = currentExtensions
        ? resolveExtensionVcsAdapters(currentExtensions.registry, baseVcsCatalog).adapters
        : [];
      const discoveryCatalog = extendVcsCatalog(baseVcsCatalog, currentAdapters);
      let configured = resolveConfiguredCliInput(runtimeInput, {
        cwd,
        vcsCatalog: discoveryCatalog,
      });
      if (configured.input.options.watch) {
        assertReliableWatchRuntime(bunVersion);
      }
      let replacementExtensions: ExtensionLoadResult | undefined;

      if (
        extensionOwnership === "owned" &&
        (options?.reloadExtensions || cwd !== activeExtensionSession.cwd)
      ) {
        try {
          const resolvedExtensions = await resolveConfiguredExtensions({
            runtimeInput,
            configured,
            cwd,
            baseVcsCatalog,
            discoveryCatalog,
            // Reuse the session hub so the mounted toast surface keeps receiving notifications.
            notifications: currentExtensions?.notifications,
            onProvisionalLoad: (result) => activeExtensionSession.trackPrepared(result),
            assertActive: () => {
              if (quitRequestedRef.current) throw reloadRefusedDuringShutdown();
            },
          });
          configured = resolvedExtensions.configured;
          replacementExtensions = resolvedExtensions.extensions;
          activeExtensionSession.trackPrepared(replacementExtensions);
        } catch (error) {
          // The resolver may fail after publishing a provisional registry but
          // before returning it. Clear host ownership through the same shared
          // retirement used by quit and the ordinary reload failure paths.
          await activeExtensionSession.retirePrepared();
          throw error;
        }
        if (quitRequestedRef.current) {
          await activeExtensionSession.retirePrepared(replacementExtensions);
          throw reloadRefusedDuringShutdown();
        }
      }

      const extensions = replacementExtensions ?? currentExtensions;
      let loaded: Awaited<ReturnType<typeof loadConfiguredSessionBootstrap>>;
      try {
        loaded = await loadConfiguredSessionBootstrap({
          configured,
          cwd,
          extensions,
          loadAtCwd: true,
          baseVcsCatalog,
        });
      } catch (error) {
        await activeExtensionSession.retirePrepared(replacementExtensions);
        throw error;
      }

      // This is the reload's commit gate. Nothing below awaits until the new
      // registry, broker snapshot, pending lifecycle, and React state all agree.
      // Quit therefore linearizes either wholly before or wholly after adoption.
      if (quitRequestedRef.current) {
        restoreFileLanguageRegistrations(loaded.previousFileLanguages);
        await activeExtensionSession.retirePrepared(replacementExtensions);
        throw reloadRefusedDuringShutdown();
      }

      let nextBootstrap!: AppBootstrap;
      let nextSnapshot!: ReturnType<typeof createInitialSessionSnapshot>;
      let sessionId = "local-session";
      try {
        const { applied, bootstrap, input: reloadInput, sessionVcs } = loaded;
        nextBootstrap = bootstrap;
        const preservedReview = reviewDescriptorAfterReload(
          reviewIdentityRef.current.input,
          reviewIdentityRef.current.cwd,
          reviewIdentityRef.current.review,
          nextBootstrap.input,
          cwd,
        );
        if (preservedReview) nextBootstrap.review = preservedReview;
        if (extensions) {
          reportExtensionApplyIssues(applied.issues, extensions.context);
        }
        nextBootstrap.startupNotices =
          sessionVcs.unknownVcsId !== undefined
            ? [
                ...(configured.startupNotices ?? []),
                // Names the backend the reload really used, detection override included.
                createUnknownVcsNotice(sessionVcs.unknownVcsId, String(reloadInput.options.vcs)),
              ]
            : configured.startupNotices;
        const preparedPublication = producer.preparePublication({
          files: nextBootstrap.changeset.files,
          sourceLabel: nextBootstrap.changeset.sourceLabel,
        });
        nextSnapshot = createInitialSessionSnapshot(nextBootstrap, preparedPublication.publication);
        const publicationReservation = producer.reservePublication(preparedPublication);
        try {
          if (hostClient) {
            // Keep the daemon-facing registration aligned with the review about to mount.
            const nextRegistration = updateSessionRegistration(
              hostClient.getRegistration(),
              nextBootstrap,
              preparedPublication.publication,
            );
            sessionId = nextRegistration.sessionId;
            hostClient.replaceSession(nextRegistration, nextSnapshot);
          }
          // The matching React store does not exist yet. Detach the previous
          // generation so broker commands refuse rather than mutate stale state
          // until the child layout effect attaches the committed review.
          publicationReservation.commit({ detachStore: true });
        } catch (error) {
          publicationReservation.cancel();
          throw error;
        }
      } catch (error) {
        restoreFileLanguageRegistrations(loaded.previousFileLanguages);
        await activeExtensionSession.retirePrepared(replacementExtensions);
        throw error;
      }

      let currentExtensionsRetired: Promise<void> | undefined;
      if (replacementExtensions) {
        // Adopt only after the review and broker publication are known-good. Adoption revokes
        // the previous registry synchronously before exposing the replacement.
        currentExtensionsRetired = activeExtensionSession.adoptPrepared(replacementExtensions, cwd);
      }
      const reloadMounted = extensions
        ? new Promise<void>((resolveMounted) => {
            pendingReloadLifecycleRef.current = {
              extensions,
              cwd,
              changeset: nextBootstrap.changeset,
              reason: options?.reason ?? "daemon",
              emitStartup: replacementExtensions !== undefined,
              resolveMounted,
            };
          })
        : undefined;

      reviewIdentityRef.current = {
        input: nextBootstrap.input,
        cwd,
        review: nextBootstrap.review,
      };
      setActiveBootstrap(nextBootstrap);
      if (options?.resetApp !== false) {
        // Bumping the key forces a full App remount. Callers that pass `resetApp: false` get a
        // soft reload that preserves in-memory UI state like selection, filter text, and pane size.
        setAppVersion((current) => current + 1);
      }

      // Keep the reload queue held until React commits the matching App and
      // lifecycle handlers receive controls leased to that review generation.
      await Promise.all([reloadMounted, currentExtensionsRetired]);

      return {
        sessionId,
        inputKind: nextBootstrap.input.kind,
        title: nextBootstrap.changeset.title,
        sourceLabel: nextBootstrap.changeset.sourceLabel,
        fileCount: nextBootstrap.changeset.files.length,
        selectedFilePath: nextSnapshot.state.selectedFilePath,
        selectedHunkIndex: nextSnapshot.state.selectedHunkIndex,
      };
    },
    [
      extensionLifecycleEnabled,
      extensionOwnership,
      activeExtensionSession,
      hostClient,
      launchExperimental,
      launchFast,
      launchExtensionsEnabled,
      launchExtensionPaths,
      producer,
      sessionFileBounds,
    ],
  );

  /** Append one operation to the session's reload coordinator. */
  const enqueueReload = useCallback(<Result,>(run: () => Promise<Result>): Promise<Result> => {
    const pending = reloadTailRef.current.then(run);
    reloadTailRef.current = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }, []);

  /** Serialize broker, watch, workspace, and manual reloads around extension replacement. */
  const reloadSession = useCallback(
    (nextInput: CliInput, options?: ReloadSessionOptions) =>
      enqueueReload(() => {
        if (quitRequestedRef.current) throw reloadRefusedDuringShutdown();
        return performReloadSession(nextInput, options);
      }),
    [enqueueReload, performReloadSession],
  );

  /** Keep the latest mounted refresh descriptor without letting stale cleanup clear its successor. */
  const registerWorkspaceRefreshRequest = useCallback((request: WorkspaceRefreshRequest) => {
    workspaceRefreshRequestRef.current = request;
    return () => {
      if (workspaceRefreshRequestRef.current === request) {
        workspaceRefreshRequestRef.current = undefined;
      }
    };
  }, []);

  /** Reconcile a completed write against whichever review owns the queue when it reaches the front. */
  const reloadAfterWorkspaceWrite = useCallback(() => {
    void enqueueReload(async () => {
      if (quitRequestedRef.current) return;
      const request = workspaceRefreshRequestRef.current;
      if (!request) return;
      await performReloadSession(request.nextInput, {
        reason: "manual",
        resetApp: false,
        sourcePath: request.sourcePath,
      });
    }).catch((error) => {
      console.error("Failed to reload after an extension workspace write.", error);
    });
  }, [enqueueReload, performReloadSession]);

  /** Coalesce extension requests and resolve their descriptor at the front of the host queue. */
  const requestExtensionReviewReload = useCallback(
    (reviewGeneration: AppBootstrap): Promise<ExtensionReviewReloadResult> => {
      const existing = pendingExtensionReloadRef.current;
      if (existing?.reviewGeneration === reviewGeneration) return existing.promise;

      const promise = enqueueReload(async () => {
        if (quitRequestedRef.current) {
          return {
            ok: false,
            reason: "unavailable",
            detail: "The review session is shutting down and cannot reload.",
          } as const;
        }
        const request = workspaceRefreshRequestRef.current;
        if (!request) {
          return {
            ok: false,
            reason: "unavailable",
            detail: "The current review cannot be reloaded from its original input.",
          } as const;
        }

        try {
          await performReloadSession(request.nextInput, {
            reason: "extension",
            resetApp: false,
            sourcePath: request.sourcePath,
          });
          return { ok: true } as const;
        } catch (error) {
          return {
            ok: false,
            reason: "failed",
            detail: describeExtensionReloadFailure(error),
          } as const;
        }
      });
      const pending = { reviewGeneration, promise };
      pendingExtensionReloadRef.current = pending;
      void promise.finally(() => {
        if (pendingExtensionReloadRef.current === pending) {
          pendingExtensionReloadRef.current = null;
        }
      });
      return promise;
    },
    [enqueueReload, performReloadSession],
  );

  /** Revoke all extension authority, finish started writes, then leave. */
  const quitAfterShutdownEvent = useCallback(() => {
    if (quitRequestedRef.current) return;
    quitRequestedRef.current = true;
    queueMicrotask(() => {
      const startedWrites = [...pendingWorkspaceWritesRef.current];
      void Promise.all([onRequestSessionShutdown(), Promise.allSettled(startedWrites)]).finally(
        onQuit,
      );
    });
  }, [onQuit, onRequestSessionShutdown]);

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
      returnToHistory={returnToHistory}
      onRegisterWorkspaceRefreshRequest={registerWorkspaceRefreshRequest}
      onReloadSession={reloadSession}
      onRequestExtensionReviewReload={requestExtensionReviewReload}
      onWorkspaceWriteCompleted={reloadAfterWorkspaceWrite}
      reviewProducer={producer}
      runWorkspaceWrite={runWorkspaceWrite}
      watchRuntime={watchRuntime}
      workspaceFileWriter={workspaceFileWriter}
    />
  );
}
