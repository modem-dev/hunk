import { useEffect, useRef, useState } from "react";
import type { UpdateNotice } from "../../core/updateNotice";

const DEFAULT_STARTUP_NOTICE_DELAY_MS = 1200;
const DEFAULT_STARTUP_NOTICE_DURATION_MS = 7000;
const DEFAULT_STARTUP_NOTICE_REPEAT_MS = 21_600_000;

interface StartupUpdateNoticeOptions {
  enabled: boolean;
  resolver?: () => Promise<UpdateNotice | null>;
}

/** Manage the session-lifetime background update notice without coupling it to chrome rendering. */
export function useStartupUpdateNotice({
  enabled,
  resolver,
}: StartupUpdateNoticeOptions) {
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current || !enabled || !resolver) {
      return;
    }

    startedRef.current = true;
    let cancelled = false;
    let inFlight = false;
    let lastShownKey: string | null = null;
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

          if (notice.key === lastShownKey) {
            return;
          }

          lastShownKey = notice.key;
          setNoticeText(notice.message);
          clearDismissTimer();
          dismissTimer = setTimeout(() => {
            if (cancelled) {
              return;
            }

            setNoticeText(null);
            dismissTimer = null;
          }, DEFAULT_STARTUP_NOTICE_DURATION_MS);
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
    }, DEFAULT_STARTUP_NOTICE_DELAY_MS);
    delayTimer.unref?.();

    const repeatTimer = setInterval(runUpdateCheck, DEFAULT_STARTUP_NOTICE_REPEAT_MS);
    repeatTimer.unref?.();

    return () => {
      cancelled = true;
      inFlight = false;
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);

      clearDismissTimer();
    };
  }, [enabled, resolver]);

  return noticeText;
}
