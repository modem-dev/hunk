import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  prepareEmbeddedHistoryReview,
  type EmbeddedHistoryReview,
  type EmbeddedHistoryReviewRequest,
} from "../../app/historyReview";
import {
  createReviewSessionRuntime,
  type ReviewSessionRuntime,
} from "../../app/session/reviewRuntime";
import type { StartupNotice } from "../../core/process/startupNotice";
import type { AppBootstrap } from "../../core/bootstrap";
import type { PersistedViewPreferences } from "../../core/run/config";
import type { InteractiveSessionInitialization } from "../../core/session/initialization";
import type { ExtensionVcsHistoryReviewAction } from "../../extension-api/types";
import { parseExtensionReviewDescriptor } from "../../core/reviewDescriptor";
import type { ExtensionSession } from "../../extensions/session";
import type { ExtensionLoadResult } from "../../extensions/types";
import { AppHost } from "../AppHost";
import type { InteractiveHistoryRuntime } from "../history/types";
import type { ViewPreferenceQuitScheduler } from "../hooks/useViewPreferenceQuitController";
import { interactiveLogUsesColor } from "../log/colorPolicy";
import { LogApp, type LogAppOutcome } from "../log/LogApp";
import { LogController } from "../log/controller";
import { resolveHistoryAuthorLabel } from "../log/formatting";
import { ThemeController } from "../theme/controller";
import { StatusApp, type StatusOutcome } from "../status/StatusApp";
import type { StatusController } from "../status/controller";
import type { StatusRuntime } from "../status/types";
import { applySessionViewPreferences } from "./viewPreferences";

export interface HistorySurfaceRoute {
  kind: "history";
  controller: LogController;
  runtime: InteractiveHistoryRuntime;
  returnRoute?: StatusSurfaceRoute;
}

export interface StatusSurfaceRoute {
  kind: "status";
  controller: StatusController;
  runtime: StatusRuntime;
}

export interface StandaloneReviewSurfaceRoute {
  kind: "review";
  instanceId: number;
  bootstrap: AppBootstrap<ExtensionLoadResult>;
  runtime: ReviewSessionRuntime;
  extensionSession: ExtensionSession;
}

export type HunkSurfaceRoute =
  | StatusSurfaceRoute
  | HistorySurfaceRoute
  | StandaloneReviewSurfaceRoute;

interface ActiveReviewSurfaceRoute extends StandaloneReviewSurfaceRoute {
  extensionOwnership: "owned" | "borrowed";
  quitBehavior: "return-to-caller" | "quit-session";
  mountMode: "initial" | "dynamic";
  returnRoute?: HistorySurfaceRoute | StatusSurfaceRoute;
  initialFilePath?: string;
}

type ActiveSurfaceRoute = StatusSurfaceRoute | HistorySurfaceRoute | ActiveReviewSurfaceRoute;

export interface HunkSessionHostDeps {
  prepareReview?: typeof prepareEmbeddedHistoryReview;
  createReviewRuntime?: typeof createReviewSessionRuntime;
  viewPreferenceQuitScheduler?: ViewPreferenceQuitScheduler;
}

/** Truncate one display field without splitting Unicode code points or exceeding transport bytes. */
function truncateReviewText(value: string, maxBytes: number) {
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Describe a history selection with bounded metadata shared by every review surface. */
function historyReviewDescriptor(
  runtime: InteractiveHistoryRuntime,
  outcome: Extract<LogAppOutcome, { kind: "open-review" }>,
  action: ExtensionVcsHistoryReviewAction,
) {
  const newest = outcome.selection.newestCommit;
  if (outcome.count === 1) {
    return parseExtensionReviewDescriptor({
      kind: "commit",
      provider: runtime.providerName,
      title: newest.subject,
      revision: newest.revisionId,
      displayRevision: truncateReviewText(newest.displayId, 64),
      author: resolveHistoryAuthorLabel(newest),
      authoredAt: newest.authoredAt,
    });
  }

  const commits = outcome.commits.slice(0, 8).map((commit) => ({
    title: truncateReviewText(commit.subject, 128),
    author: truncateReviewText(resolveHistoryAuthorLabel(commit), 64),
    authoredAt: commit.authoredAt,
    revision: commit.revisionId,
    displayRevision: truncateReviewText(commit.displayId, 64),
  }));
  const comparison = {
    kind: "comparison" as const,
    provider: runtime.providerName,
    title: `${outcome.count} commits`,
    base:
      action.kind === "revision-range"
        ? action.fromRevisionId
        : outcome.selection.oldestCommit.revisionId,
    head: action.kind === "revision-range" ? action.toRevisionId : newest.revisionId,
    commitCount: outcome.count,
  };
  for (let count = commits.length; count >= 0; count -= 1) {
    const review = parseExtensionReviewDescriptor({
      ...comparison,
      ...(count > 0 ? { commits: commits.slice(0, count) } : {}),
    });
    if (review) return review;
  }
  return null;
}

/**
 * Route retained status/history and fresh review surfaces inside one stable React root.
 *
 * Workspace inspection, history selections and standalone review startup converge here. The host owns route preparation
 * and review-surface disposal; `runHunkSession` retains terminal ownership, while `AppHost` retains
 * review reload and extension-event commit ordering.
 */
export function HunkSessionHost({
  initialRoute,
  initialization,
  externalQuitSignal,
  onQuit,
  startupNoticeResolver,
  deps = {},
}: {
  initialRoute: HunkSurfaceRoute;
  initialization: InteractiveSessionInitialization;
  externalQuitSignal: AbortSignal;
  onQuit: (exitCode?: number) => void;
  startupNoticeResolver?: () => Promise<StartupNotice | null>;
  deps?: HunkSessionHostDeps;
}) {
  const renderer = useRenderer();
  const prepareReview = deps.prepareReview ?? prepareEmbeddedHistoryReview;
  const createReviewRuntime = deps.createReviewRuntime ?? createReviewSessionRuntime;
  const [themeController] = useState(
    () =>
      new ThemeController({
        ...initialization.theme,
        initialThemeMode: initialization.theme.initialThemeMode ?? renderer.themeMode,
      }),
  );
  const [route, setRoute] = useState<ActiveSurfaceRoute>(() =>
    initialRoute.kind !== "review"
      ? initialRoute
      : {
          ...initialRoute,
          extensionOwnership: "owned",
          quitBehavior: "quit-session",
          mountMode: "initial",
        },
  );
  const routeRef = useRef(route);
  routeRef.current = route;
  const mountedRef = useRef(true);
  const preparingRef = useRef(false);
  const preparationControllerRef = useRef<AbortController | null>(null);
  const preparationGenerationRef = useRef(0);
  const preparationSettlementRef = useRef<Promise<void> | null>(null);
  const nextInstanceRef = useRef(initialRoute.kind === "review" ? initialRoute.instanceId + 1 : 1);
  const quitRequestedRef = useRef(false);
  const shutdownPendingRef = useRef(false);
  const pendingExitCodeRef = useRef<number | undefined>(undefined);
  const failedReviewStopsRef = useRef(new Set<ReviewSessionRuntime>());
  const sessionViewPreferencesRef = useRef(initialization.viewPreferences);
  const retainSessionViewPreferences = useCallback((preferences: PersistedViewPreferences) => {
    sessionViewPreferencesRef.current = preferences;
  }, []);

  /** Attempt broker cleanup and retain failed runtimes for the final unmount retry. */
  const stopReviewRuntime = useCallback((runtime: ReviewSessionRuntime) => {
    try {
      runtime.stop();
      failedReviewStopsRef.current.delete(runtime);
    } catch {
      failedReviewStopsRef.current.add(runtime);
    }
  }, []);

  const historyClosuresRef = useRef(new WeakMap<LogController, Promise<void>>());
  /** Drain each status-owned history once across return, shutdown, preparation and unmount. */
  const closeStatusHistory = useCallback((history: LogController, status: StatusController) => {
    const previous = historyClosuresRef.current.get(history);
    if (previous) return previous;
    const closing = Promise.resolve()
      .then(() => history.close())
      .catch((error) => {
        status.setNotice(
          `History cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    historyClosuresRef.current.set(history, closing);
    return closing;
  }, []);

  const completeQuit = useCallback(() => {
    if (quitRequestedRef.current) return;
    quitRequestedRef.current = true;
    const current = routeRef.current;
    const history =
      current.kind === "history"
        ? current
        : current.kind === "review" && current.returnRoute?.kind === "history"
          ? current.returnRoute
          : undefined;
    const status =
      current.kind === "status"
        ? current
        : (history?.returnRoute ??
          (current.kind === "review" && current.returnRoute?.kind === "status"
            ? current.returnRoute
            : undefined));
    void (async () => {
      if (history?.returnRoute)
        await closeStatusHistory(history.controller, history.returnRoute.controller);
      await status?.controller.close();
      onQuit(pendingExitCodeRef.current);
    })().catch(() => onQuit(pendingExitCodeRef.current ?? 1));
  }, [onQuit, closeStatusHistory]);

  const requestQuit = useCallback(
    (exitCode?: number) => {
      shutdownPendingRef.current = true;
      if (pendingExitCodeRef.current === undefined) pendingExitCodeRef.current = exitCode;
      preparationGenerationRef.current += 1;
      preparationControllerRef.current?.abort(
        new Error("Hunk surface preparation was cancelled during shutdown."),
      );
      if (routeRef.current.kind !== "review" && !preparingRef.current) completeQuit();
    },
    [completeQuit],
  );

  const retireReview = useCallback(() => {
    const current = routeRef.current;
    if (current.kind !== "review") return;
    stopReviewRuntime(current.runtime);
    if (externalQuitSignal.aborted || current.quitBehavior === "quit-session") {
      completeQuit();
      return;
    }
    const returnRoute = current.returnRoute;
    if (!returnRoute) {
      completeQuit();
      return;
    }
    routeRef.current = returnRoute;
    setRoute(returnRoute);
  }, [completeQuit, externalQuitSignal, stopReviewRuntime]);

  const handleHistoryOutcome = async (
    historyRoute: HistorySurfaceRoute,
    outcome: LogAppOutcome,
  ) => {
    if (outcome.kind === "cancel-open-review") {
      const settlement = preparationSettlementRef.current;
      preparationGenerationRef.current += 1;
      preparationControllerRef.current?.abort(
        new Error("Hunk review preparation was cancelled before a history quit decision."),
      );
      await settlement;
      return;
    }
    if (outcome.kind === "quit") {
      if (historyRoute.returnRoute && !externalQuitSignal.aborted && !shutdownPendingRef.current) {
        await closeStatusHistory(historyRoute.controller, historyRoute.returnRoute.controller);
        if (!mountedRef.current || routeRef.current !== historyRoute) return;
        if (externalQuitSignal.aborted || shutdownPendingRef.current) {
          completeQuit();
          return;
        }
        routeRef.current = historyRoute.returnRoute;
        setRoute(historyRoute.returnRoute);
        return;
      }
      requestQuit(outcome.exitCode);
      return;
    }
    if (
      !mountedRef.current ||
      shutdownPendingRef.current ||
      externalQuitSignal.aborted ||
      preparingRef.current ||
      routeRef.current.kind !== "history"
    ) {
      return;
    }
    preparingRef.current = true;
    let settlePreparation!: () => void;
    const preparationSettlement = new Promise<void>((resolve) => {
      settlePreparation = resolve;
    });
    preparationSettlementRef.current = preparationSettlement;
    const generation = ++preparationGenerationRef.current;
    const preparationController = new AbortController();
    preparationControllerRef.current = preparationController;
    const signal = AbortSignal.any([externalQuitSignal, preparationController.signal]);
    const startupCwd = historyRoute.runtime.startupCwd ?? historyRoute.runtime.repoRoot;
    let plan: EmbeddedHistoryReview | undefined;
    try {
      const reviewOptions =
        outcome.parentRevisionId === undefined
          ? undefined
          : { parentRevisionId: outcome.parentRevisionId };
      const action =
        outcome.count === 1
          ? await historyRoute.runtime.planReview(
              outcome.selection.newestCommit,
              reviewOptions,
              signal,
            )
          : await historyRoute.runtime.planRangeReview?.(outcome.selection, reviewOptions, signal);
      if (!action) {
        throw new Error("This history provider does not support multi-commit review.");
      }
      signal.throwIfAborted();
      const request: EmbeddedHistoryReviewRequest = {
        action,
        providerId: historyRoute.runtime.providerId,
        startupCwd,
        extensionsEnabled: historyRoute.runtime.input.extensionsEnabled,
        extensionPaths: historyRoute.runtime.input.extensionPaths,
        extensionSession: historyRoute.runtime.extensionSession.current,
        themeId: themeController.getSnapshot().themeId,
        themeMode: themeController.themeMode,
      };
      if (historyRoute.returnRoute) {
        const bootstrap = await historyRoute.returnRoute.runtime.prepareHistoryReview(
          action,
          historyRoute.runtime.repoRoot,
          signal,
        );
        plan = {
          bootstrap,
          initialization,
          borrowsExtensions:
            bootstrap.extensions?.registry ===
            historyRoute.runtime.extensionSession.current.registry,
        };
      } else plan = await prepareReview(request, { signal });
      const historyReview = historyReviewDescriptor(historyRoute.runtime, outcome, action);
      if (historyReview) {
        plan.bootstrap.review = historyReview;
        plan.bootstrap.reviewSource = "caller";
      }
      if (!plan.bootstrap.extensions) {
        throw new Error("Embedded review startup did not provide extension authority.");
      }
      signal.throwIfAborted();
      if (
        !mountedRef.current ||
        generation !== preparationGenerationRef.current ||
        routeRef.current !== historyRoute
      ) {
        if (!plan.borrowsExtensions) {
          historyRoute.runtime.extensionSession.trackPrepared(plan.bootstrap.extensions);
          await historyRoute.runtime.extensionSession.retirePrepared(plan.bootstrap.extensions);
        }
        return;
      }
      if (!plan.borrowsExtensions) {
        historyRoute.runtime.extensionSession.trackPrepared(plan.bootstrap.extensions);
        await historyRoute.runtime.extensionSession.retirePrepared(plan.bootstrap.extensions);
        throw new Error("An embedded review cannot replace the owning extension session.");
      }
      const reviewBootstrap = applySessionViewPreferences(plan.bootstrap, {
        ...sessionViewPreferencesRef.current,
        theme: themeController.getSnapshot().themeId,
      });
      const reviewRuntime = createReviewRuntime(
        reviewBootstrap,
        historyRoute.returnRoute ? historyRoute.runtime.repoRoot : startupCwd,
      );
      themeController.replaceCustomThemes(plan.initialization.theme.customThemes);
      const reviewRoute: ActiveReviewSurfaceRoute = {
        kind: "review",
        instanceId: nextInstanceRef.current++,
        bootstrap: reviewBootstrap,
        runtime: reviewRuntime,
        extensionSession: historyRoute.runtime.extensionSession,
        extensionOwnership: "borrowed",
        quitBehavior: "return-to-caller",
        mountMode: "dynamic",
        returnRoute: historyRoute,
      };
      routeRef.current = reviewRoute;
      setRoute(reviewRoute);
    } catch (error) {
      const preparedExtensions = plan?.bootstrap.extensions;
      if (
        plan &&
        preparedExtensions &&
        !plan.borrowsExtensions &&
        routeRef.current.kind !== "review"
      ) {
        historyRoute.runtime.extensionSession.trackPrepared(preparedExtensions);
        await historyRoute.runtime.extensionSession.retirePrepared(preparedExtensions);
      }
      if (!signal.aborted) throw error;
    } finally {
      if (preparationControllerRef.current === preparationController) {
        preparationControllerRef.current = null;
      }
      preparingRef.current = false;
      if (preparationSettlementRef.current === preparationSettlement) {
        preparationSettlementRef.current = null;
      }
      settlePreparation();
      if (shutdownPendingRef.current && routeRef.current.kind !== "review") {
        completeQuit();
      }
    }
  };

  /** Prepare status child routes with launch-owned extensions and inspected-target source facts. */
  const handleStatusOutcome = async (status: StatusSurfaceRoute, outcome: StatusOutcome) => {
    if (outcome.kind === "cancel-prepare") {
      preparationGenerationRef.current++;
      preparationControllerRef.current?.abort();
      await preparationSettlementRef.current;
      return;
    }
    if (outcome.kind === "quit") {
      requestQuit();
      return;
    }
    if (
      !mountedRef.current ||
      shutdownPendingRef.current ||
      externalQuitSignal.aborted ||
      preparingRef.current ||
      routeRef.current !== status
    )
      return;
    preparingRef.current = true;
    const generation = ++preparationGenerationRef.current;
    const abort = new AbortController();
    preparationControllerRef.current = abort;
    const signal = AbortSignal.any([abort.signal, externalQuitSignal]);
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    preparationSettlementRef.current = settlement;
    let history: LogController | undefined;
    let historyClosing: Promise<void> | undefined;
    const cancelHistory = () => {
      const closing = history;
      if (!closing || historyClosing) return;
      historyClosing = closeStatusHistory(closing, status.controller);
    };
    signal.addEventListener("abort", cancelHistory, { once: true });
    try {
      await status.controller.suspend();
      signal.throwIfAborted();
      const snapshot = status.controller.getSnapshot().snapshot;
      if (outcome.kind === "open-log") {
        const runtime = await status.runtime.openHistory(snapshot.worktree.path, signal);
        history = new LogController(runtime);
        if (signal.aborted) cancelHistory();
        signal.throwIfAborted();
        await history.loadMore();
        signal.throwIfAborted();
        if (
          !mountedRef.current ||
          generation !== preparationGenerationRef.current ||
          routeRef.current !== status
        )
          return;
        const next: HistorySurfaceRoute = {
          kind: "history",
          runtime,
          controller: history,
          returnRoute: status,
        };
        routeRef.current = next;
        setRoute(next);
        history = undefined;
      } else {
        const action = await status.runtime.planReview(snapshot, outcome.actionId, signal);
        signal.throwIfAborted();
        // An explicit visible untracked row overrides the launch exclusion only for this full
        // comparison; the effective input also survives AppHost manual/watch reloads.
        const input =
          outcome.filePath &&
          snapshot.paths.some(
            (path) => path.path === outcome.filePath && path.worktree === "untracked",
          )
            ? { ...action.input, options: { ...action.input.options, excludeUntracked: false } }
            : action.input;
        const bootstrap = await status.runtime.prepareReview(input, action.cwd, signal);
        if (bootstrap.extensions?.registry !== status.runtime.extensionSession.current.registry) {
          if (bootstrap.extensions) {
            status.runtime.extensionSession.trackPrepared(bootstrap.extensions);
            await status.runtime.extensionSession.retirePrepared(bootstrap.extensions);
          }
          throw new Error("An embedded review cannot replace the owning extension session.");
        }
        signal.throwIfAborted();
        if (
          !mountedRef.current ||
          generation !== preparationGenerationRef.current ||
          routeRef.current !== status
        )
          return;
        const reviewBootstrap = applySessionViewPreferences(bootstrap, {
          ...sessionViewPreferencesRef.current,
          theme: themeController.getSnapshot().themeId,
        });
        const next: ActiveReviewSurfaceRoute = {
          kind: "review",
          instanceId: nextInstanceRef.current++,
          bootstrap: reviewBootstrap,
          runtime: createReviewRuntime(reviewBootstrap, action.cwd),
          extensionSession: status.runtime.extensionSession,
          extensionOwnership: "borrowed",
          quitBehavior: "return-to-caller",
          mountMode: "dynamic",
          returnRoute: status,
          initialFilePath: outcome.filePath,
        };
        routeRef.current = next;
        setRoute(next);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      signal.removeEventListener("abort", cancelHistory);
      try {
        cancelHistory();
        await historyClosing;
      } finally {
        // Cleanup errors must never strand a cancelling caller or global shutdown.
        if (preparationControllerRef.current === abort) preparationControllerRef.current = null;
        preparingRef.current = false;
        if (preparationSettlementRef.current === settlement)
          preparationSettlementRef.current = null;
        settle();
        if (shutdownPendingRef.current && routeRef.current.kind !== "review") completeQuit();
        else if (mountedRef.current && routeRef.current === status && !externalQuitSignal.aborted)
          status.controller.resume();
      }
    }
  };

  useEffect(() => {
    const requestExternalQuit = () => requestQuit();
    if (externalQuitSignal.aborted) requestExternalQuit();
    else
      externalQuitSignal.addEventListener("abort", requestExternalQuit, {
        once: true,
      });
    return () => externalQuitSignal.removeEventListener("abort", requestExternalQuit);
  }, [externalQuitSignal, requestQuit]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      preparationGenerationRef.current += 1;
      preparationControllerRef.current?.abort(
        new Error("Hunk session host unmounted during surface preparation."),
      );
      const current = routeRef.current;
      if (current.kind === "review") stopReviewRuntime(current.runtime);
      const history =
        current.kind === "history"
          ? current
          : current.kind === "review" && current.returnRoute?.kind === "history"
            ? current.returnRoute
            : undefined;
      if (history?.returnRoute)
        void closeStatusHistory(history.controller, history.returnRoute.controller);
      for (const runtime of failedReviewStopsRef.current) stopReviewRuntime(runtime);
    },
    [stopReviewRuntime, closeStatusHistory],
  );

  if (route.kind === "review") {
    return (
      <AppHost
        key={route.instanceId}
        bootstrap={route.bootstrap}
        externalQuitSignal={externalQuitSignal}
        hostClient={route.runtime.hostClient}
        onQuit={retireReview}
        {...(route.quitBehavior === "return-to-caller"
          ? { onViewPreferencesChange: retainSessionViewPreferences }
          : {})}
        {...(route.mountMode === "dynamic" ? { onFirstFrameReady: () => undefined } : {})}
        returnToSurface={route.returnRoute?.kind}
        initialFilePath={route.initialFilePath}
        sessionCustomThemes={
          route.returnRoute?.kind === "status" ||
          (route.returnRoute?.kind === "history" && route.returnRoute.returnRoute)
            ? initialization.theme.customThemes
            : undefined
        }
        extensionSession={route.extensionSession}
        extensionOwnership={route.extensionOwnership}
        onRequestSessionShutdown={
          route.extensionOwnership === "owned"
            ? () => route.extensionSession.shutdown()
            : async () => undefined
        }
        reviewProducer={route.runtime.reviewProducer}
        startupNoticeResolver={startupNoticeResolver}
        themeController={themeController}
      />
    );
  }

  if (route.kind === "status")
    return (
      <StatusApp
        controller={route.controller}
        runtime={route.runtime}
        themeController={themeController}
        sessionViewPreferences={sessionViewPreferencesRef.current}
        onOutcome={(outcome) => handleStatusOutcome(route, outcome)}
        quitScheduler={deps.viewPreferenceQuitScheduler}
      />
    );

  return (
    <LogApp
      controller={route.controller}
      runtime={route.runtime}
      returnToStatus={Boolean(route.returnRoute)}
      transparentBackground={route.returnRoute?.runtime.launchOptions.transparentBackground}
      useColor={interactiveLogUsesColor(route.runtime.input.color, process.env)}
      onOutcome={(outcome) => handleHistoryOutcome(route, outcome)}
      quitScheduler={deps.viewPreferenceQuitScheduler}
      sessionViewPreferences={sessionViewPreferencesRef.current}
      themeController={themeController}
    />
  );
}
