import { useEffect, useRef, useState } from "react";
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
}

/** Manage the session-lifetime background update notice without coupling it to chrome rendering. */
export function useStartupUpdateNotice({
  delayMs = DEFAULT_STARTUP_NOTICE_DELAY_MS,
  durationMs = DEFAULT_STARTUP_NOTICE_DURATION_MS,
  enabled,
  repeatMs = DEFAULT_STARTUP_NOTICE_REPEAT_MS,
  resolver,
}: StartupUpdateNoticeOptions) {
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const lastShownKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !resolver) {
      setNoticeText(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let dismissTimer: ReturnType<typeof setTimeout> | null = null;

    const clearDismissTimer = () => {
      if (!dismissTimer) {
        return;
      }

      clearTimeout(dismissTimer);
      dismissTimer = null;
    };

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
          setNoticeText(notice.message);
          clearDismissTimer();
          dismissTimer = setTimeout(() => {
            if (cancelled) {
              return;
            }

            setNoticeText(null);
            dismissTimer = null;
          }, durationMs);
          dismissTimer.unref?.();
        })
        .catch(() => {
          // Ignore non-blocking update-check failures.
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const delayTimer = setTimeout(() => {
      runUpdateCheck();
    }, delayMs);
    delayTimer.unref?.();

    const repeatTimer = setInterval(runUpdateCheck, repeatMs);
    repeatTimer.unref?.();

    return () => {
      cancelled = true;
      inFlight = false;
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      clearDismissTimer();
    };
  }, [delayMs, durationMs, enabled, repeatMs, resolver]);

  return noticeText;
}
