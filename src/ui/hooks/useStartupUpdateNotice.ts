import { useEffect, useRef } from "react";
import type { UpdateNotice } from "../../core/updateNotice";

const DEFAULT_STARTUP_NOTICE_DELAY_MS = 1200;
const DEFAULT_STARTUP_NOTICE_DURATION_MS = 7000;
const DEFAULT_STARTUP_NOTICE_REPEAT_MS = 21_600_000;

interface StartupUpdateNoticeOptions {
  delayMs?: number;
  durationMs?: number;
  enabled: boolean;
  repeatMs?: number;
  resolver?: () => Promise<UpdateNotice | null>;
  showNotice: (message: string, durationMs: number) => void;
}

/** Drive a session-lifetime background update check that publishes through the shared notice channel. */
export function useStartupUpdateNotice({
  delayMs = DEFAULT_STARTUP_NOTICE_DELAY_MS,
  durationMs = DEFAULT_STARTUP_NOTICE_DURATION_MS,
  enabled,
  repeatMs = DEFAULT_STARTUP_NOTICE_REPEAT_MS,
  resolver,
  showNotice,
}: StartupUpdateNoticeOptions) {
  const lastShownKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !resolver) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const runUpdateCheck = () => {
      if (cancelled || inFlight) {
        return;
      }

      inFlight = true;
      void resolver()
        .then((notice) => {
          if (cancelled || !notice) {
            return;
          }

          if (notice.key === lastShownKeyRef.current) {
            return;
          }

          lastShownKeyRef.current = notice.key;
          showNotice(notice.message, durationMs);
        })
        .catch(() => {
          // Ignore non-blocking update-check failures.
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const delayTimer = setTimeout(runUpdateCheck, delayMs);
    delayTimer.unref?.();

    const repeatTimer = setInterval(runUpdateCheck, repeatMs);
    repeatTimer.unref?.();

    return () => {
      cancelled = true;
      inFlight = false;
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
    };
  }, [delayMs, durationMs, enabled, repeatMs, resolver, showNotice]);
}
