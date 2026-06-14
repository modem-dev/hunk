import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
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

/**
 * Manage the session-lifetime background update notice without coupling it to chrome rendering.
 * Returns an accessor for the current notice text (null when nothing should be shown). The
 * `enabled`/`resolver`/timing options are captured once at mount, matching the prior one-shot
 * effect setup.
 */
export function useStartupUpdateNotice(
  options: StartupUpdateNoticeOptions,
): Accessor<string | null> {
  const delayMs = options.delayMs ?? DEFAULT_STARTUP_NOTICE_DELAY_MS;
  const durationMs = options.durationMs ?? DEFAULT_STARTUP_NOTICE_DURATION_MS;
  const repeatMs = options.repeatMs ?? DEFAULT_STARTUP_NOTICE_REPEAT_MS;
  const { enabled, resolver } = options;

  const [noticeText, setNoticeText] = createSignal<string | null>(null);
  let lastShownKey: string | null = null;

  onMount(() => {
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

    onCleanup(() => {
      cancelled = true;
      inFlight = false;
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      clearDismissTimer();
    });
  });

  return noticeText;
}
