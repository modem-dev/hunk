import { useEffect, useRef, useState } from "react";
import type {
  ExtensionNotification,
  ExtensionNotificationHub,
} from "../../extensions/notifications";
import {
  enqueueExtensionNotification,
  EXTENSION_TOAST_DURATION_MS,
} from "../lib/extensionNotifications";

/**
 * Subscribe the app to extension notifications and surface them one at a time.
 *
 * Subscribing is what turns the host's buffering sink into a live one: anything
 * an extension notified before the app mounted (a `startup` handler, a load-time
 * transform) flushes here in arrival order. Each notification is shown for a
 * fixed window and then replaced by the next, so a burst reads as a sequence
 * rather than one message the user never sees.
 */
export function useExtensionNotifications(
  notifications: ExtensionNotificationHub | undefined,
  { durationMs = EXTENSION_TOAST_DURATION_MS }: { durationMs?: number } = {},
) {
  const [queue, setQueue] = useState<ExtensionNotification[]>([]);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!notifications) {
      return;
    }

    return notifications.subscribe((notification) => {
      setQueue((current) => enqueueExtensionNotification(current, notification));
    });
  }, [notifications]);

  const active = queue[0] ?? null;

  useEffect(() => {
    if (!active) {
      return;
    }

    dismissTimerRef.current = setTimeout(() => {
      dismissTimerRef.current = null;
      // Drop by id rather than by index so a flush that arrived mid-timer
      // cannot make the timeout retire the wrong notification.
      setQueue((current) => current.filter((entry) => entry.id !== active.id));
    }, durationMs);

    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [active, durationMs]);

  return active;
}
