import { useEffect, useRef } from "react";
import {
  createWatchController,
  type WatchControllerClock,
  type WatchEventSourceCallbacks,
} from "../../core/watchController";
import { createWatchEventSource } from "../../core/watchObserver";
import { computeWatchSignature } from "../../core/watch";
import { resolveWatchPlan, type WatchPlan } from "../../core/watchPlan";
import type { CliInput, ReloadContext } from "../../core/types";

export interface WatchedInputRuntime {
  clock?: WatchControllerClock;
  getSignature?: (input: CliInput, context: ReloadContext) => string;
  resolvePlan?: (input: CliInput, context: ReloadContext) => WatchPlan | null;
  createEventSource?: (plan: WatchPlan, callbacks: WatchEventSourceCallbacks) => { close(): void };
}

const defaultRuntime: WatchedInputRuntime = {};

/** Own the observer and controller lifecycle for one reloadable input. */
export function useWatchedInput({
  enabled,
  input,
  reloadContext,
  refresh,
  runtime = defaultRuntime,
}: {
  enabled: boolean;
  input: CliInput;
  reloadContext: ReloadContext;
  refresh: () => void | Promise<void>;
  runtime?: WatchedInputRuntime;
}) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

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
      initialSignature,
      pollOnly: plan.coverage === "poll-only",
      refresh: () => refreshRef.current(),
      reportError: (error) => console.error("Failed to auto-reload the current diff.", error),
    });

    return () => controller.close();
  }, [enabled, input, reloadContext, runtime]);
}
