import { useEffect, useRef } from "react";
import {
  createWatchController,
  type WatchControllerClock,
  type WatchEventSourceCallbacks,
} from "../../core/watch/controller";
import { createWatchEventSource } from "../../core/watch/observer";
import { resolveWatchPlan, type WatchPlan } from "../../core/watch/plan";
import { computeWatchSignature } from "../../core/watch/signature";
import type { ReloadContext } from "../../core/bootstrap";
import type { CliInput } from "../../core/run/commandInputs";

export interface WatchedInputRuntime {
  clock?: WatchControllerClock;
  getSignature?: (input: CliInput, context: ReloadContext) => string;
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
    let initialSignature: string;
    try {
      plan = (runtime.resolvePlan ?? resolveWatchPlan)(input, reloadContext);
      if (!plan) return;
      initialSignature =
        runtime.getSignature === undefined && reloadContext.initialWatchSignature !== undefined
          ? reloadContext.initialWatchSignature
          : getSignature(input, reloadContext);
    } catch (error) {
      console.error("Failed to initialize watch mode.", error);
      return;
    }

    const eventSourceFactory = runtime.createEventSource
      ? (callbacks: WatchEventSourceCallbacks) => runtime.createEventSource!(plan, callbacks)
      : createWatchEventSource(plan);
    const controller = createWatchController({
      clock: runtime.clock,
      createEventSource: eventSourceFactory,
      getSignature: () => getSignature(input, reloadContext),
      healthyCheckMs: hasDirectFileContent(plan) ? DIRECT_FILE_WATCH_SAFETY_CHECK_MS : undefined,
      initialSignature,
      onReloadPending: () => pendingRef.current?.(),
      pollOnly: plan.coverage === "poll-only",
      refresh: () => refreshRef.current(),
      reportError: (error) => console.error("Failed to auto-reload the current diff.", error),
    });

    return () => controller.close();
  }, [enabled, input, reloadContext, runtime]);
}
