/**
 * Owns timer lifecycles for presentation-independent notice channels.
 * Callers decide how channels are presented and prioritized.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface TimedNoticeScheduler {
  setTimeout(callback: () => void, durationMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface TimedNotice {
  text: string | null;
  show: (text: string) => void;
  clear: () => void;
}

const defaultScheduler: TimedNoticeScheduler = {
  setTimeout: (callback, durationMs) => setTimeout(callback, durationMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

type ScheduledNotice = {
  handle: unknown;
  scheduler: TimedNoticeScheduler;
};

/** Shows one notice for the configured duration and replaces any pending timer. */
export function useTimedNotice(
  durationMs: number,
  scheduler: TimedNoticeScheduler = defaultScheduler,
): TimedNotice {
  const [text, setText] = useState<string | null>(null);
  const timerRef = useRef<ScheduledNotice | null>(null);
  const generationRef = useRef(0);
  const optionsRef = useRef({ durationMs, scheduler });
  optionsRef.current = { durationMs, scheduler };

  const show = useCallback((nextText: string) => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    const pending = timerRef.current;
    timerRef.current = null;
    pending?.scheduler.clearTimeout(pending.handle);

    setText(nextText);
    const options = optionsRef.current;
    const handle = options.scheduler.setTimeout(() => {
      if (generationRef.current !== generation) return;
      timerRef.current = null;
      setText(null);
    }, options.durationMs);
    timerRef.current = { handle, scheduler: options.scheduler };
  }, []);

  const clear = useCallback(() => {
    generationRef.current += 1;
    const pending = timerRef.current;
    timerRef.current = null;
    pending?.scheduler.clearTimeout(pending.handle);
    setText(null);
  }, []);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      const pending = timerRef.current;
      timerRef.current = null;
      pending?.scheduler.clearTimeout(pending.handle);
    };
  }, []);

  return { text, show, clear };
}
