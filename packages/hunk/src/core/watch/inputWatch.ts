/**
 * Watches one reloadable review input and asks for a refresh when its content changes.
 *
 * The terminal's watch hook and a headless review session both arm this for the input they
 * currently show and close it when that input is replaced. It resolves the input's watch plan,
 * starts the observer and the debounced signature controller, and reports refresh failures
 * without stopping the watch. It renders nothing and owns no reload logic: `refresh` is the
 * caller's route into its reload coordinator.
 */
import {
  createWatchController,
  type WatchControllerClock,
  type WatchEventSourceCallbacks,
} from "./controller";
import { createWatchEventSource } from "./observer";
import { resolveWatchPlan, type WatchPlan } from "./plan";
import { computeWatchSignature } from "./signature";
import type { CliInput } from "../run/commandInputs";
import type { VcsCatalog } from "../vcs/types";

/** Where a watched input was loaded, as the review's reload context records it. */
export interface WatchedInputContext {
  cwd: string;
  repoRoot?: string;
  initialWatchSignature?: string;
  vcsCatalog?: VcsCatalog;
}

/** Injectable watch dependencies; tests replace the clock, signatures, plans, and observers. */
export interface WatchedInputRuntime {
  clock?: WatchControllerClock;
  getSignature?: (
    input: CliInput,
    context: WatchedInputContext & { signal?: AbortSignal },
  ) => string | Promise<string>;
  resolvePlan?: (input: CliInput, context: WatchedInputContext) => WatchPlan | null;
  createEventSource?: (plan: WatchPlan, callbacks: WatchEventSourceCallbacks) => { close(): void };
}

const DIRECT_FILE_WATCH_SAFETY_CHECK_MS = 2_000;

/** Return whether a watch plan needs the short file-stat safety check. */
function hasDirectFileContent(plan: WatchPlan) {
  return plan.targets.some(
    (target) => target.kind === "directory-entries" && target.sources.includes("content"),
  );
}

/**
 * Start watching one input; returns nothing when the input has no watch plan or the plan
 * could not be resolved (reported, not thrown).
 */
export function startInputWatch({
  input,
  reloadContext,
  onReloadPending,
  refresh,
  runtime = {},
}: {
  input: CliInput;
  reloadContext: WatchedInputContext;
  onReloadPending?: () => void;
  refresh: () => void | Promise<void>;
  runtime?: WatchedInputRuntime;
}): { close(): void } | undefined {
  const getSignature = runtime.getSignature ?? computeWatchSignature;
  let plan: WatchPlan | null;
  try {
    plan = (runtime.resolvePlan ?? resolveWatchPlan)(input, reloadContext);
    if (!plan) return undefined;
  } catch (error) {
    console.error("Failed to initialize watch mode.", error);
    return undefined;
  }

  const eventSourceFactory = runtime.createEventSource
    ? (callbacks: WatchEventSourceCallbacks) => runtime.createEventSource!(plan, callbacks)
    : createWatchEventSource(plan);
  return createWatchController({
    clock: runtime.clock,
    createEventSource: eventSourceFactory,
    getSignature: (signal) => getSignature(input, { ...reloadContext, signal }),
    healthyCheckMs: hasDirectFileContent(plan) ? DIRECT_FILE_WATCH_SAFETY_CHECK_MS : undefined,
    initialSignature: reloadContext.initialWatchSignature,
    onReloadPending: () => onReloadPending?.(),
    pollOnly: plan.coverage === "poll-only",
    refresh,
    reportError: (error) => console.error("Failed to auto-reload the current diff.", error),
  });
}
