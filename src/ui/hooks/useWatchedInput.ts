import { useEffect, useRef } from "react";
import {
  createWatchController,
  type WatchController,
  type WatchControllerClock,
  type WatchEventSourceCallbacks,
} from "../../core/watchController";
import { createWatchEventSource } from "../../core/watchObserver";
import { computeWatchSignature } from "../../core/watch";
import { resolveWatchPlan, type WatchPlan } from "../../core/watchPlan";
import type { CliInput, ReloadContext } from "../../core/types";

export interface WatchedInputRuntime {
  clock?: WatchControllerClock;
  getSignature?: (
    input: CliInput,
    context: ReloadContext & { signal?: AbortSignal },
  ) => string | Promise<string>;
  resolvePlan?: (input: CliInput, context: ReloadContext) => WatchPlan | null;
  createEventSource?: (plan: WatchPlan, callbacks: WatchEventSourceCallbacks) => { close(): void };
}

const defaultRuntime: WatchedInputRuntime = {};
const DIRECT_FILE_WATCH_SAFETY_CHECK_MS = 2_000;

/** Return whether a watch plan needs the short file-stat safety check. */
function hasDirectFileContent(plan: WatchPlan) {
  return plan.targets.some(
    (target) => target.kind === "directory-entries" && target.sources.includes("content"),
  );
}

/** Own the observer and controller lifecycle for one reloadable input. */
export function useWatchedInput({
  enabled,
  input,
  reloadContext,
  onReloadPending,
  refresh,
  runtime = defaultRuntime,
}: {
  enabled: boolean;
  input: CliInput;
  onReloadPending?: () => void;
  reloadContext: ReloadContext;
  refresh: () => void | Promise<void>;
  runtime?: WatchedInputRuntime;
}) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const pendingRef = useRef(onReloadPending);
  pendingRef.current = onReloadPending;

  useEffect(() => {
    if (!enabled) return;

    const getSignature = runtime.getSignature ?? computeWatchSignature;
    let plan: WatchPlan | null;
    try {
      plan = (runtime.resolvePlan ?? resolveWatchPlan)(input, reloadContext);
      if (!plan) return;
    } catch (error) {
      console.error("Failed to initialize watch mode.", error);
      return;
    }

    const watchedPlan = plan;
    // The controller needs its baseline signature before it can start, and
    // computing one may now shell out. Bootstrap normally supplies it, so this
    // only awaits on the fallback path; either way the controller is created
    // once and torn down by whichever of the two branches below runs last.
    let controller: WatchController | undefined;
    let cancelled = false;

    const start = (initialSignature: string) => {
      if (cancelled) return;

      controller = createWatchController({
        clock: runtime.clock,
        createEventSource: runtime.createEventSource
          ? (callbacks: WatchEventSourceCallbacks) =>
              runtime.createEventSource!(watchedPlan, callbacks)
          : createWatchEventSource(watchedPlan),
        getSignature: (signal) => getSignature(input, { ...reloadContext, signal }),
        healthyCheckMs: hasDirectFileContent(watchedPlan)
          ? DIRECT_FILE_WATCH_SAFETY_CHECK_MS
          : undefined,
        initialSignature,
        onReloadPending: () => pendingRef.current?.(),
        pollOnly: watchedPlan.coverage === "poll-only",
        refresh: () => refreshRef.current(),
        reportError: (error) => console.error("Failed to auto-reload the current diff.", error),
      });
    };

    if (runtime.getSignature === undefined && reloadContext.initialWatchSignature !== undefined) {
      start(reloadContext.initialWatchSignature);
    } else {
      void Promise.resolve()
        .then(() => getSignature(input, reloadContext))
        .then(start)
        .catch((error) => console.error("Failed to initialize watch mode.", error));
    }

    return () => {
      cancelled = true;
      controller?.close();
    };
  }, [enabled, input, reloadContext, runtime]);
}
