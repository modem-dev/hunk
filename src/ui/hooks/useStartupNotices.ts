import { useEffect, useRef, useState } from "react";
import type { StartupNotice } from "../../core/startupNotice";

const DEFAULT_STARTUP_NOTICE_DELAY_MS = 1200;
const DEFAULT_STARTUP_NOTICE_DURATION_MS = 7000;
const DEFAULT_STARTUP_NOTICE_REPEAT_MS = 21_600_000;
const EMPTY_STARTUP_NOTICES: readonly StartupNotice[] = [];

interface StartupNoticeOptions {
  delayMs?: number;
  durationMs?: number;
  enabled: boolean;
  notices?: readonly StartupNotice[];
  repeatMs?: number;
  resolver?: () => Promise<StartupNotice | null>;
}

/** Queue local and asynchronously resolved startup notices for the shared footer surface. */
export function useStartupNotices({
  delayMs = DEFAULT_STARTUP_NOTICE_DELAY_MS,
  durationMs = DEFAULT_STARTUP_NOTICE_DURATION_MS,
  enabled,
  notices = EMPTY_STARTUP_NOTICES,
  repeatMs = DEFAULT_STARTUP_NOTICE_REPEAT_MS,
  resolver,
}: StartupNoticeOptions) {
  const [noticeText, setNoticeText] = useState<string | null>(null);
  // Startup notices are AppHost-scoped: config reloads must not replay a notice the user saw.
  const shownKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) {
      setNoticeText(null);
      return;
    }

    setNoticeText(null);

    let cancelled = false;
    let inFlight = false;
    let activeNotice = false;
    let dismissTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingNotices: StartupNotice[] = [];
    const pendingKeys = new Set<string>();

    const showNextNotice = () => {
      if (cancelled || activeNotice) {
        return;
      }

      const notice = pendingNotices.shift();
      if (!notice) {
        setNoticeText(null);
        return;
      }

      pendingKeys.delete(notice.key);
      shownKeysRef.current.add(notice.key);
      activeNotice = true;
      setNoticeText(notice.message);
      dismissTimer = setTimeout(() => {
        if (cancelled) {
          return;
        }

        dismissTimer = null;
        activeNotice = false;
        setNoticeText(null);
        showNextNotice();
      }, durationMs);
      dismissTimer.unref?.();
    };

    const enqueueNotice = (notice: StartupNotice | null) => {
      if (!notice || shownKeysRef.current.has(notice.key) || pendingKeys.has(notice.key)) {
        return;
      }

      pendingKeys.add(notice.key);
      pendingNotices.push(notice);
      showNextNotice();
    };

    for (const notice of notices) {
      enqueueNotice(notice);
    }

    const runNoticeCheck = () => {
      if (cancelled || inFlight || !resolver) {
        return;
      }

      inFlight = true;
      void resolver()
        .then((notice) => {
          if (!cancelled) {
            enqueueNotice(notice);
          }
        })
        .catch(() => {
          // Ignore non-blocking startup notice failures.
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const delayTimer = setTimeout(runNoticeCheck, delayMs);
    delayTimer.unref?.();

    const repeatTimer = setInterval(runNoticeCheck, repeatMs);
    repeatTimer.unref?.();

    return () => {
      cancelled = true;
      inFlight = false;
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      if (dismissTimer) {
        clearTimeout(dismissTimer);
      }
    };
  }, [delayMs, durationMs, enabled, notices, repeatMs, resolver]);

  return noticeText;
}
