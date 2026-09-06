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
import { retireExtensionLoadResult } from "../../extensions/events";
import type { ExtensionLoadResult } from "../../extensions/types";
import { AppHost } from "../AppHost";
import type { HistoryRuntime } from "../history/types";
import { interactiveLogUsesColor } from "../log/colorPolicy";
import { LogApp, type LogAppOutcome } from "../log/LogApp";
import type { LogController } from "../log/controller";

export interface HistorySurfaceRoute {
  kind: "history";
  controller: LogController;
  runtime: HistoryRuntime;
}

export interface StandaloneReviewSurfaceRoute {
  kind: "review";
  instanceId: number;
  bootstrap: AppBootstrap<ExtensionLoadResult>;
  runtime: ReviewSessionRuntime;
}

export type HunkSurfaceRoute = HistorySurfaceRoute | StandaloneReviewSurfaceRoute;

interface ActiveReviewSurfaceRoute extends StandaloneReviewSurfaceRoute {
  extensionOwnership: "owned" | "borrowed";
  quitBehavior: "return-to-history" | "quit-session";
  mountMode: "initial" | "dynamic";
  returnRoute?: HistorySurfaceRoute;
}

type ActiveSurfaceRoute = HistorySurfaceRoute | ActiveReviewSurfaceRoute;

export interface HunkSessionHostDeps {
  prepareReview?: typeof prepareEmbeddedHistoryReview;
  createReviewRuntime?: typeof createReviewSessionRuntime;
  retirePreparedExtensions?: typeof retireExtensionLoadResult;
}

/**
 * Route retained history and fresh review surfaces inside one stable React root.
 *
 * History selections and standalone review startup converge here. The host owns route preparation
 * and review-surface disposal; `runHunkSession` retains terminal ownership, while `AppHost` retains
 * review reload and extension-event commit ordering.
 */
export function HunkSessionHost({
  initialRoute,
  externalQuitSignal,
  onQuit,
  startupNoticeResolver,
  deps = {},
}: {
  initialRoute: HunkSurfaceRoute;
  externalQuitSignal: AbortSignal;
  onQuit: (exitCode?: number) => void;
  startupNoticeResolver?: () => Promise<StartupNotice | null>;
  deps?: HunkSessionHostDeps;
}) {
  const prepareReview = deps.prepareReview ?? prepareEmbeddedHistoryReview;
  const createReviewRuntime = deps.createReviewRuntime ?? createReviewSessionRuntime;
  const retirePreparedExtensions = deps.retirePreparedExtensions ?? retireExtensionLoadResult;
  const [route, setRoute] = useState<ActiveSurfaceRoute>(() =>
    initialRoute.kind === "history"
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
  const nextInstanceRef = useRef(initialRoute.kind === "review" ? initialRoute.instanceId + 1 : 1);
  const quitRequestedRef = useRef(false);
  const shutdownPendingRef = useRef(false);
  const pendingExitCodeRef = useRef<number | undefined>(undefined);
  const failedReviewStopsRef = useRef(new Set<ReviewSessionRuntime>());

  /** Attempt broker cleanup and retain failed runtimes for the final unmount retry. */
  const stopReviewRuntime = useCallback((runtime: ReviewSessionRuntime) => {
    try {
      runtime.stop();
      failedReviewStopsRef.current.delete(runtime);
    } catch {
      failedReviewStopsRef.current.add(runtime);
    }
  }, []);

  const completeQuit = useCallback(() => {
    if (quitRequestedRef.current) return;
    quitRequestedRef.current = true;
    onQuit(pendingExitCodeRef.current);
  }, [onQuit]);

  const requestQuit = useCallback(
    (exitCode?: number) => {
      shutdownPendingRef.current = true;
      if (pendingExitCodeRef.current === undefined) pendingExitCodeRef.current = exitCode;
      preparationGenerationRef.current += 1;
      preparationControllerRef.current?.abort(
        new Error("Hunk surface preparation was cancelled during shutdown."),
      );
      if (routeRef.current.kind === "history" && !preparingRef.current) completeQuit();
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
    if (outcome.kind === "quit") {
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
    const generation = ++preparationGenerationRef.current;
    const preparationController = new AbortController();
    preparationControllerRef.current = preparationController;
    const signal = AbortSignal.any([externalQuitSignal, preparationController.signal]);
    const startupCwd = historyRoute.runtime.startupCwd ?? historyRoute.runtime.repoRoot;
    let plan: EmbeddedHistoryReview | undefined;
    try {
      const action = await historyRoute.runtime.planReview(
        outcome.commit,
        outcome.parentRevisionId === undefined
          ? undefined
          : { parentRevisionId: outcome.parentRevisionId },
      );
      signal.throwIfAborted();
      const request: EmbeddedHistoryReviewRequest = {
        action,
        providerId: historyRoute.runtime.providerId,
        startupCwd,
        extensionsEnabled: historyRoute.runtime.input.extensionsEnabled,
        extensionPaths: historyRoute.runtime.input.extensionPaths,
        extensionSession: historyRoute.runtime.extensionSession,
        themeId: outcome.themeId,
        themeMode: outcome.themeMode,
      };
      plan = await prepareReview(request, { signal });
      signal.throwIfAborted();
      if (
        !mountedRef.current ||
        generation !== preparationGenerationRef.current ||
        routeRef.current !== historyRoute
      ) {
        if (!plan.borrowsExtensions) {
          await retirePreparedExtensions(plan.bootstrap.extensions);
        }
        return;
      }
      const reviewRuntime = createReviewRuntime(plan.bootstrap, startupCwd);
      const reviewRoute: ActiveReviewSurfaceRoute = {
        kind: "review",
        instanceId: nextInstanceRef.current++,
        bootstrap: plan.bootstrap,
        runtime: reviewRuntime,
        extensionOwnership: plan.borrowsExtensions ? "borrowed" : "owned",
        quitBehavior: "return-to-history",
        mountMode: "dynamic",
        returnRoute: historyRoute,
      };
      routeRef.current = reviewRoute;
      setRoute(reviewRoute);
    } catch (error) {
      if (plan && !plan.borrowsExtensions && routeRef.current.kind !== "review") {
        await retirePreparedExtensions(plan.bootstrap.extensions);
      }
      if (!signal.aborted) throw error;
    } finally {
      if (preparationControllerRef.current === preparationController) {
        preparationControllerRef.current = null;
      }
      preparingRef.current = false;
      if (shutdownPendingRef.current && routeRef.current.kind === "history") {
        completeQuit();
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
      for (const runtime of failedReviewStopsRef.current) stopReviewRuntime(runtime);
    },
    [stopReviewRuntime],
  );

  if (route.kind === "review") {
    return (
      <AppHost
        key={route.instanceId}
        bootstrap={route.bootstrap}
        externalQuitSignal={externalQuitSignal}
        hostClient={route.runtime.hostClient}
        onQuit={retireReview}
        {...(route.mountMode === "dynamic" ? { onFirstFrameReady: () => undefined } : {})}
        returnToHistory={route.quitBehavior === "return-to-history"}
        extensionOwnership={route.extensionOwnership}
        reviewProducer={route.runtime.reviewProducer}
        startupNoticeResolver={startupNoticeResolver}
      />
    );
  }

  return (
    <LogApp
      controller={route.controller}
      runtime={route.runtime}
      useColor={interactiveLogUsesColor(route.runtime.input.color, process.env)}
      onOutcome={(outcome) => handleHistoryOutcome(route, outcome)}
    />
  );
}
