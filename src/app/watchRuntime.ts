import { computeWatchSignature } from "../core/watch";
import {
  createWatchController,
  type WatchController,
  type WatchControllerClock,
  type WatchEventSourceCallbacks,
} from "../core/watchController";
import { createWatchEventSource } from "../core/watchObserver";
import { resolveWatchPlan, type WatchPlan } from "../core/watchPlan";
import type { CliInput, ReloadContext } from "../core/types";

export interface WatchedInputRuntime {
  clock?: WatchControllerClock;
  getSignature?: (input: CliInput, context: ReloadContext) => string;
  resolvePlan?: (input: CliInput, context: ReloadContext) => WatchPlan | null;
  createEventSource?: (plan: WatchPlan, callbacks: WatchEventSourceCallbacks) => { close(): void };
}

const DIRECT_FILE_WATCH_SAFETY_CHECK_MS = 2_000;

/** Return whether a watch plan needs the short file-stat safety check. */
function hasDirectFileContent(plan: WatchPlan) {
  return plan.targets.some(
    (target) => target.kind === "directory-entries" && target.sources.includes("content"),
  );
}

/** Create the non-React observer/controller lifecycle for one watched input. */
export function createWatchedInputController({
  input,
  reloadContext,
  onReloadPending,
  refresh,
  runtime = {},
}: {
  input: CliInput;
  onReloadPending?: () => void;
  reloadContext: ReloadContext;
  refresh: () => void | Promise<void>;
  runtime?: WatchedInputRuntime;
}): WatchController | null {
  const getSignature = runtime.getSignature ?? computeWatchSignature;
  let plan: WatchPlan | null;
  let initialSignature: string;
  try {
    plan = (runtime.resolvePlan ?? resolveWatchPlan)(input, reloadContext);
    if (!plan) return null;
    initialSignature =
      runtime.getSignature === undefined && reloadContext.initialWatchSignature !== undefined
        ? reloadContext.initialWatchSignature
        : getSignature(input, reloadContext);
  } catch (error) {
    console.error("Failed to initialize watch mode.", error);
    return null;
  }

  const eventSourceFactory = runtime.createEventSource
    ? (callbacks: WatchEventSourceCallbacks) => runtime.createEventSource!(plan, callbacks)
    : createWatchEventSource(plan);

  return createWatchController({
    clock: runtime.clock,
    createEventSource: eventSourceFactory,
    getSignature: () => getSignature(input, reloadContext),
    healthyCheckMs: hasDirectFileContent(plan) ? DIRECT_FILE_WATCH_SAFETY_CHECK_MS : undefined,
    initialSignature,
    onReloadPending,
    pollOnly: plan.coverage === "poll-only",
    refresh,
    reportError: (error) => console.error("Failed to auto-reload the current diff.", error),
  });
}
