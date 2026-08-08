/**
 * One timer standing in for several named deadlines.
 *
 * Watch mode tracks four independent "wake me at" times — event debounce, the
 * debounce's hard cap, the periodic safety check, and the event source's
 * startup budget — but only ever needs the earliest of them armed. Keeping that
 * collapsing here leaves `watchController` free to talk about phases and checks
 * instead of timer handles, and lets the arithmetic be tested on its own.
 *
 * The scheduler is deliberately passive: it never re-arms itself after firing.
 * The controller decides what a due deadline means and arms again when it is
 * ready for the next one, which is what keeps timers from firing during a check.
 */

/** Test seam for time, so deadline arithmetic can be driven without real timers. */
export interface DeadlineClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultDeadlineClock: DeadlineClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The deadlines watch mode tracks. Each name may be pending at most once. */
export type WatchDeadline = "startup" | "quiet" | "maximum" | "safety";

export interface DeadlineScheduler {
  /** Set one deadline to an absolute time, replacing any pending value. */
  set(name: WatchDeadline, at: number): void;
  /** Set one deadline only when it is not already pending, retaining the first value. */
  setIfUnset(name: WatchDeadline, at: number): void;
  /** Move one deadline earlier, never later, setting it when nothing is pending. */
  advance(name: WatchDeadline, at: number): void;
  /** Drop the named deadlines, or every deadline when called with no names. */
  clear(...names: WatchDeadline[]): void;
  /** Report whether one deadline is currently pending. */
  has(name: WatchDeadline): boolean;
  /** List the pending deadlines that have arrived by `now`. */
  due(now: number): WatchDeadline[];
  /** Arm the single timer for the earliest pending deadline. */
  arm(): void;
  /** Cancel the timer, leaving pending deadlines in place. */
  disarm(): void;
}

export interface DeadlineSchedulerOptions {
  clock?: DeadlineClock;
  /** Called once each time the armed timer fires; the scheduler stays disarmed until re-armed. */
  onDue: () => void;
}

/** Coordinate several named deadlines behind one chained timeout. */
export function createDeadlineScheduler({
  clock = defaultDeadlineClock,
  onDue,
}: DeadlineSchedulerOptions): DeadlineScheduler {
  const deadlines = new Map<WatchDeadline, number>();
  let timer: unknown;
  // The time the armed timer is currently aimed at, so re-arming for an
  // unchanged earliest deadline does not churn the underlying timeout.
  let armedFor: number | undefined;

  const disarm = () => {
    if (timer !== undefined) {
      clock.clearTimeout(timer);
    }
    timer = undefined;
    armedFor = undefined;
  };

  const fire = () => {
    timer = undefined;
    armedFor = undefined;
    onDue();
  };

  return {
    set(name, at) {
      deadlines.set(name, at);
    },

    setIfUnset(name, at) {
      if (!deadlines.has(name)) {
        deadlines.set(name, at);
      }
    },

    advance(name, at) {
      const pending = deadlines.get(name);
      deadlines.set(name, pending === undefined ? at : Math.min(pending, at));
    },

    clear(...names) {
      if (names.length === 0) {
        deadlines.clear();
        return;
      }

      for (const name of names) {
        deadlines.delete(name);
      }
    },

    has(name) {
      return deadlines.has(name);
    },

    due(now) {
      return [...deadlines].flatMap(([name, at]) => (at <= now ? [name] : []));
    },

    arm() {
      if (deadlines.size === 0) {
        return;
      }

      const earliest = Math.min(...deadlines.values());
      if (armedFor === earliest) {
        return;
      }

      disarm();
      armedFor = earliest;
      timer = clock.setTimeout(fire, Math.max(0, earliest - clock.now()));
    },

    disarm,
  };
}
