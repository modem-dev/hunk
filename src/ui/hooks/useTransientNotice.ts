import { useCallback, useEffect, useRef, useState } from "react";

export interface TransientNoticeChannel {
  noticeText: string | null;
  showNotice: (message: string, durationMs: number) => void;
}

/**
 * One transient status-bar notice channel shared by all app actions that need it.
 * Last writer wins; the prior dismiss timer is cleared so notices never linger past
 * their successor.
 */
export function useTransientNotice(): TransientNoticeChannel {
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearDismissTimer, [clearDismissTimer]);

  const showNotice = useCallback(
    (message: string, durationMs: number) => {
      clearDismissTimer();
      setNoticeText(message);
      const timer = setTimeout(() => {
        setNoticeText(null);
        dismissTimerRef.current = null;
      }, durationMs);
      timer.unref?.();
      dismissTimerRef.current = timer;
    },
    [clearDismissTimer],
  );

  return { noticeText, showNotice };
}
