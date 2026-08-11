import {
  createDeadlineScheduler,
  defaultDeadlineClock,
  type DeadlineClock,
} from "./watchDeadlines";

export type WatchControllerPhase =
  | "starting"
  | "idle"
  | "debouncing"
  | "checking"
  | "refreshing"
  | "closed";

/**
 * Test seam for time.
 *
 * Re-exported from the deadline scheduler, which owns every timer the
 * controller arms, so callers keep one clock type to inject.
 */
export type WatchControllerClock = DeadlineClock;

export interface WatchEventSource {
  close(): void;
}

export interface WatchEventSourceCallbacks {
  onEvent(): void;
  onError(error: unknown): void;
  onReady?(): void;
}

export const DEFAULT_WATCH_EVENT_SOURCE_STARTUP_TIMEOUT_MS = 2_000;
export const WATCH_EVENT_SOURCE_STARTUP_TIMEOUT_CODE = "HUNK_WATCH_EVENT_SOURCE_STARTUP_TIMEOUT";
/** Intentional cancellation of one check without closing its controller. */
export const WATCH_CHECK_CANCELLED_CODE = "HUNK_WATCH_CHECK_CANCELLED";

export interface WatchControllerOptions {
  initialSignature: string;
  /**
   * Compute the current signature.
   *
   * Receives a signal that aborts when the controller closes, so an
   * implementation that shells out can stop work nobody will read. Prefer an
   * asynchronous implementation: this runs on every debounced event and every
   * safety poll, and a blocking one stalls the terminal UI each time.
   */
  getSignature: (signal: AbortSignal) => string | Promise<string>;
  /** Apply a refresh. Receives the same close signal as `getSignature`. */
  refresh: (signal: AbortSignal) => void | Promise<void>;
  /** A source event arrived and a debounced signature check is now pending. */
  onReloadPending?: () => void;
  clock?: WatchControllerClock;
  createEventSource?: (callbacks: WatchEventSourceCallbacks) => WatchEventSource;
  pollOnly?: boolean;
  reportError?: (error: unknown) => void;
  quietDelayMs?: number;
  maximumDelayMs?: number;
  healthyCheckMs?: number;
  degradedCheckMs?: number;
  duplicateErrorIntervalMs?: number;
  startupTimeoutMs?: number;
}

export interface WatchControllerState {
  phase: WatchControllerPhase;
  dirty: boolean;
  degraded: boolean;
  appliedSignature: string;
}

export interface WatchController {
  close(): void;
  getState(): Readonly<WatchControllerState>;
}

/** Read an error code without relying on a particular watcher error class. */
function getErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return String(error.code);
}

/** Produce a stable key used to suppress repeated reports from a noisy event source. */
function getErrorKey(error: unknown) {
  const code = getErrorCode(error);
  if (code) return `code:${code}`;
  if (error instanceof Error) return `${error.name}:${error.message}`;
  return String(error);
}

/** Report whether a failure is just this controller's own abort landing on in-flight work. */
function isAbortError(error: unknown) {
  return (
    (error instanceof Error && error.name === "AbortError") || getErrorCode(error) === "ABORT_ERR"
  );
}

/** Build the stable diagnostic reported when an event source cannot establish readiness. */
function createEventSourceStartupTimeoutError(timeoutMs: number) {
  return Object.assign(
    new Error(`The watch event source did not become ready within ${timeoutMs} ms.`),
    {
      code: WATCH_EVENT_SOURCE_STARTUP_TIMEOUT_CODE,
      name: "WatchEventSourceStartupTimeoutError",
    },
  );
}

/** What one awaited step of a check produced, once closure and failure are accounted for. */
type CheckStep<T> = { done: true; value: T } | { done: false };

/** Coordinate event hints and periodic checks without coupling to a watcher backend. */
export function createWatchController(options: WatchControllerOptions): WatchController {
  const clock = options.clock ?? defaultDeadlineClock;
  const quietDelayMs = options.quietDelayMs ?? 200;
  const maximumDelayMs = options.maximumDelayMs ?? 1_000;
  const healthyCheckMs = options.healthyCheckMs ?? 10_000;
  const degradedCheckMs = options.degradedCheckMs ?? 2_000;
  const duplicateErrorIntervalMs = options.duplicateErrorIntervalMs ?? 10_000;
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_WATCH_EVENT_SOURCE_STARTUP_TIMEOUT_MS;

  const state: WatchControllerState = {
    phase: "starting",
    dirty: false,
    degraded: Boolean(options.pollOnly),
    appliedSignature: options.initialSignature,
  };
  let eventSource: WatchEventSource | undefined;
  let sourceStatus: "none" | "starting" | "ready" | "closed" = "none";
  // Aborted on close, so work started for a check nobody will read can stop
  // instead of running to completion and having its result discarded.
  const lifetime = new AbortController();
  const reportedAt = new Map<string, number>();

  const deadlines = createDeadlineScheduler({ clock, onDue: () => onTimer() });

  /** Report an error at most once per configured interval for the same error key. */
  const reportError = (error: unknown) => {
    const key = getErrorKey(error);
    const now = clock.now();
    const previous = reportedAt.get(key);
    if (previous !== undefined && now - previous < duplicateErrorIntervalMs) return;
    reportedAt.set(key, now);
    options.reportError?.(error);
  };

  const safetyInterval = () => (state.degraded ? degradedCheckMs : healthyCheckMs);

  /** Arm the next relevant deadline, retaining source startup coverage during a check. */
  const schedule = () => {
    if (state.phase === "closed") return;

    if (state.phase === "checking" || state.phase === "refreshing") {
      // Debounce and safety deadlines pause while a check owns the controller,
      // but source registration must remain bounded even when that check awaits.
      if (deadlines.has("startup")) deadlines.arm();
      else deadlines.disarm();
      return;
    }

    deadlines.arm();
  };

  /** Test closure across async boundaries without relying on narrowed phase state. */
  const isClosed = () => state.phase === "closed";

  /** Test source closure after construction callbacks that TypeScript cannot observe. */
  const isSourceClosed = () => sourceStatus === "closed";

  /** Close the current source once and invalidate all of its later callbacks. */
  const closeEventSource = () => {
    if (sourceStatus === "none" || sourceStatus === "closed") return;
    sourceStatus = "closed";
    deadlines.clear("startup");
    const source = eventSource;
    eventSource = undefined;
    source?.close();
  };

  /** Finish work and honor all in-flight hints as one trailing check. */
  const finishCheck = () => {
    if (isClosed()) return;
    deadlines.set("safety", clock.now() + safetyInterval());
    state.phase = "idle";
    if (state.dirty) {
      state.dirty = false;
      void beginCheck();
      return;
    }
    schedule();
  };

  /**
   * Await one step of a check, absorbing the two things that end it early.
   *
   * Every `await` inside a check has to answer the same two questions — did the
   * controller close while we were parked, and did the work fail — and the
   * answer is always the same. Funneling them here means adding a step to
   * `beginCheck` cannot reintroduce the missing-guard bug that a hand-written
   * `if (isClosed()) return` at each site invites.
   */
  const runCheckStep = async <T>(work: () => T | Promise<T>): Promise<CheckStep<T>> => {
    try {
      const value = await work();
      if (isClosed()) return { done: false };
      return { done: true, value };
    } catch (error) {
      if (isClosed()) return { done: false };
      // An abort that is neither our close nor an explicitly superseded check
      // still deserves a report.
      const checkWasSuperseded =
        isAbortError(error) && getErrorCode(error) === WATCH_CHECK_CANCELLED_CODE;
      if (!checkWasSuperseded && (!isAbortError(error) || !lifetime.signal.aborted)) {
        reportError(error);
      }
      finishCheck();
      return { done: false };
    }
  };

  /** Run one serialized signature check and refresh only when it changed. */
  const beginCheck = async () => {
    if (state.phase === "closed" || state.phase === "checking" || state.phase === "refreshing") {
      return;
    }
    deadlines.disarm();
    deadlines.clear("quiet", "maximum", "safety");
    state.phase = "checking";
    // The source may still be registering. Keep that independent deadline live
    // while an asynchronous signature check owns every other controller phase.
    schedule();

    const signature = await runCheckStep(() => options.getSignature(lifetime.signal));
    if (!signature.done) return;

    if (signature.value === state.appliedSignature) {
      finishCheck();
      return;
    }

    state.phase = "refreshing";
    const refreshed = await runCheckStep(() => options.refresh(lifetime.signal));
    if (!refreshed.done) return;

    state.appliedSignature = signature.value;
    finishCheck();
  };

  /** Degrade one source that failed to establish readiness before its deadline. */
  const degradeStalledSource = () => {
    if (sourceStatus !== "starting") return;
    const checkInFlight = state.phase === "checking" || state.phase === "refreshing";
    closeEventSource();
    state.degraded = true;
    if (!checkInFlight) state.phase = "idle";
    deadlines.clear("quiet", "maximum");
    deadlines.set("safety", clock.now() + degradedCheckMs);
    reportError(createEventSourceStartupTimeoutError(startupTimeoutMs));
    schedule();
  };

  /** Consume a due startup, debounce, maximum-delay, or safety deadline as one check. */
  function onTimer() {
    if (state.phase === "closed") return;

    const due = new Set(deadlines.due(clock.now()));
    if (due.has("startup")) {
      degradeStalledSource();
      return;
    }

    if (due.has("quiet") || due.has("maximum") || due.has("safety")) {
      void beginCheck();
      return;
    }

    schedule();
  }

  /** Treat an event as a hint and retain the first event's maximum deadline. */
  const onEvent = () => {
    if (state.phase === "closed" || (sourceStatus !== "starting" && sourceStatus !== "ready")) {
      return;
    }
    if (state.phase === "checking" || state.phase === "refreshing") {
      state.dirty = true;
      return;
    }
    const now = clock.now();
    // Report one pending reload per debounce window, not once per noisy file event.
    if (state.phase !== "debouncing") {
      options.onReloadPending?.();
    }
    deadlines.set("quiet", now + quietDelayMs);
    deadlines.setIfUnset("maximum", now + maximumDelayMs);
    state.phase = "debouncing";
    schedule();
  };

  /** Close the startup scan race with an immediate signature check after watcher readiness. */
  const onSourceReady = () => {
    if (state.phase === "closed" || sourceStatus !== "starting") return;
    sourceStatus = "ready";
    deadlines.clear("startup");
    if (state.phase === "checking" || state.phase === "refreshing") {
      // The startup timer can be the one deadline still armed during a check.
      // Readiness retires it while preserving one trailing verification pass.
      schedule();
      state.dirty = true;
      return;
    }
    void beginCheck();
  };

  /** Degrade only for watcher resource exhaustion; other source errors stay nonfatal. */
  const onSourceError = (error: unknown) => {
    if (state.phase === "closed" || sourceStatus === "closed") return;
    const code = getErrorCode(error);
    if (code === "ENOSPC" || code === "EMFILE") {
      state.degraded = true;
      closeEventSource();
      deadlines.advance("safety", clock.now() + degradedCheckMs);
      schedule();
    }
    reportError(error);
  };

  state.phase = "idle";
  deadlines.set("safety", clock.now() + safetyInterval());
  if (options.createEventSource && !options.pollOnly) {
    sourceStatus = "starting";
    deadlines.set("startup", clock.now() + startupTimeoutMs);
    // This JS timer is a secondary guard: FSEvents lock contention can also delay timers, so
    // bounded native registration remains the primary macOS protection.
    schedule();
    try {
      const createdSource = options.createEventSource({
        onEvent,
        onError: onSourceError,
        onReady: onSourceReady,
      });
      if (isSourceClosed()) createdSource.close();
      else eventSource = createdSource;
    } catch (error) {
      sourceStatus = "closed";
      deadlines.clear("startup");
      state.degraded = true;
      deadlines.set("safety", clock.now() + degradedCheckMs);
      reportError(error);
    }
  }
  schedule();

  return {
    /** Stop observation and abandon any in-flight asynchronous work. */
    close() {
      if (state.phase === "closed") return;
      state.phase = "closed";
      state.dirty = false;
      deadlines.clear();
      deadlines.disarm();
      closeEventSource();
      lifetime.abort();
    },
    /** Expose a snapshot for diagnostics without allowing state mutation. */
    getState() {
      return { ...state };
    },
  };
}
