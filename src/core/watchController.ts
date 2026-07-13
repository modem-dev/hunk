export type WatchControllerPhase =
  | "starting"
  | "idle"
  | "debouncing"
  | "checking"
  | "refreshing"
  | "closed";

export interface WatchControllerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WatchEventSource {
  close(): void;
}

export interface WatchEventSourceCallbacks {
  onEvent(): void;
  onError(error: unknown): void;
  onReady?(): void;
}

export interface WatchControllerOptions {
  initialSignature: string;
  getSignature: () => string | Promise<string>;
  refresh: () => void | Promise<void>;
  clock?: WatchControllerClock;
  createEventSource?: (callbacks: WatchEventSourceCallbacks) => WatchEventSource;
  pollOnly?: boolean;
  reportError?: (error: unknown) => void;
  quietDelayMs?: number;
  maximumDelayMs?: number;
  healthyCheckMs?: number;
  degradedCheckMs?: number;
  duplicateErrorIntervalMs?: number;
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

const defaultClock: WatchControllerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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

/** Coordinate event hints and periodic checks without coupling to a watcher backend. */
export function createWatchController(options: WatchControllerOptions): WatchController {
  const clock = options.clock ?? defaultClock;
  const quietDelayMs = options.quietDelayMs ?? 200;
  const maximumDelayMs = options.maximumDelayMs ?? 1_000;
  const healthyCheckMs = options.healthyCheckMs ?? 10_000;
  const degradedCheckMs = options.degradedCheckMs ?? 2_000;
  const duplicateErrorIntervalMs = options.duplicateErrorIntervalMs ?? 10_000;

  const state: WatchControllerState = {
    phase: "starting",
    dirty: false,
    degraded: Boolean(options.pollOnly),
    appliedSignature: options.initialSignature,
  };
  let eventSource: WatchEventSource | undefined;
  let timer: unknown;
  let timerDeadline: number | undefined;
  let quietDeadline: number | undefined;
  let maximumDeadline: number | undefined;
  let safetyDeadline: number | undefined;
  const reportedAt = new Map<string, number>();

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

  /** Clear the one active chained timeout. */
  const clearTimer = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    timerDeadline = undefined;
  };

  /** Schedule only the earliest outstanding deadline. */
  const schedule = () => {
    if (state.phase === "closed" || state.phase === "checking" || state.phase === "refreshing") {
      return;
    }
    const deadlines = [quietDeadline, maximumDeadline, safetyDeadline].filter(
      (deadline): deadline is number => deadline !== undefined,
    );
    if (deadlines.length === 0) return;
    const deadline = Math.min(...deadlines);
    if (timerDeadline === deadline) return;
    clearTimer();
    timerDeadline = deadline;
    timer = clock.setTimeout(onTimer, Math.max(0, deadline - clock.now()));
  };

  /** Test closure across async boundaries without relying on narrowed phase state. */
  const isClosed = () => state.phase === "closed";

  /** Finish work and honor all in-flight hints as one trailing check. */
  const finishCheck = () => {
    if (isClosed()) return;
    safetyDeadline = clock.now() + safetyInterval();
    state.phase = "idle";
    if (state.dirty) {
      state.dirty = false;
      void beginCheck();
      return;
    }
    schedule();
  };

  /** Run one serialized signature check and refresh only when it changed. */
  const beginCheck = async () => {
    if (state.phase === "closed" || state.phase === "checking" || state.phase === "refreshing") {
      return;
    }
    clearTimer();
    quietDeadline = undefined;
    maximumDeadline = undefined;
    safetyDeadline = undefined;
    state.phase = "checking";

    let signature: string;
    try {
      signature = await options.getSignature();
    } catch (error) {
      if (isClosed()) return;
      reportError(error);
      finishCheck();
      return;
    }
    if (isClosed()) return;
    if (signature === state.appliedSignature) {
      finishCheck();
      return;
    }

    state.phase = "refreshing";
    try {
      await options.refresh();
    } catch (error) {
      if (isClosed()) return;
      reportError(error);
      finishCheck();
      return;
    }
    if (isClosed()) return;
    state.appliedSignature = signature;
    finishCheck();
  };

  /** Consume a due debounce, maximum-delay, or safety deadline as one check. */
  function onTimer() {
    timer = undefined;
    timerDeadline = undefined;
    if (state.phase === "closed") return;
    const now = clock.now();
    const eventDue =
      (quietDeadline !== undefined && quietDeadline <= now) ||
      (maximumDeadline !== undefined && maximumDeadline <= now);
    const safetyDue = safetyDeadline !== undefined && safetyDeadline <= now;
    if (eventDue || safetyDue) {
      void beginCheck();
    } else {
      schedule();
    }
  }

  /** Treat an event as a hint and retain the first event's maximum deadline. */
  const onEvent = () => {
    if (state.phase === "closed") return;
    if (state.phase === "checking" || state.phase === "refreshing") {
      state.dirty = true;
      return;
    }
    const now = clock.now();
    quietDeadline = now + quietDelayMs;
    maximumDeadline ??= now + maximumDelayMs;
    state.phase = "debouncing";
    schedule();
  };

  /** Close the startup scan race with an immediate signature check after watcher readiness. */
  const onSourceReady = () => {
    if (state.phase === "closed") return;
    if (state.phase === "checking" || state.phase === "refreshing") {
      state.dirty = true;
      return;
    }
    void beginCheck();
  };

  /** Degrade only for watcher resource exhaustion; other source errors stay nonfatal. */
  const onSourceError = (error: unknown) => {
    if (state.phase === "closed") return;
    const code = getErrorCode(error);
    if (code === "ENOSPC" || code === "EMFILE") {
      state.degraded = true;
      eventSource?.close();
      eventSource = undefined;
      safetyDeadline = Math.min(
        safetyDeadline ?? Number.POSITIVE_INFINITY,
        clock.now() + degradedCheckMs,
      );
      schedule();
    }
    reportError(error);
  };

  state.phase = "idle";
  safetyDeadline = clock.now() + safetyInterval();
  if (options.createEventSource && !options.pollOnly) {
    try {
      eventSource = options.createEventSource({
        onEvent,
        onError: onSourceError,
        onReady: onSourceReady,
      });
    } catch (error) {
      state.degraded = true;
      safetyDeadline = clock.now() + degradedCheckMs;
      reportError(error);
    }
  }
  schedule();

  return {
    /** Stop observation and ignore any later asynchronous completion. */
    close() {
      if (state.phase === "closed") return;
      state.phase = "closed";
      state.dirty = false;
      quietDeadline = undefined;
      maximumDeadline = undefined;
      safetyDeadline = undefined;
      clearTimer();
      eventSource?.close();
      eventSource = undefined;
    },
    /** Expose a snapshot for diagnostics without allowing state mutation. */
    getState() {
      return { ...state };
    },
  };
}
