import type { ExtensionNotifyType } from "../extension-api/types";

/**
 * Cap on notifications held while nothing is listening.
 *
 * Extensions may notify from a `startup` handler that runs before the app has
 * mounted its toast surface, so the hub buffers. The cap keeps a chatty (or
 * looping) extension from growing that buffer without bound; the oldest
 * messages are dropped because the newest are the ones still worth showing.
 */
const MAX_BUFFERED_NOTIFICATIONS = 32;

/** One `ctx.notify` call, normalized for the UI queue. */
export interface ExtensionNotification {
  /** Monotonic within one hub, so the UI can key rows and detect replacement. */
  id: number;
  message: string;
  type: ExtensionNotifyType;
}

export type ExtensionNotificationListener = (notification: ExtensionNotification) => void;

/**
 * The single sink every extension's `ctx.notify` writes into.
 *
 * The host creates one hub per process and hands its `notify` to the load pass,
 * so extensions can notify at any point in the session lifecycle. The UI
 * subscribes once it has mounted a surface to show them on; anything that
 * arrived earlier is flushed to that first subscriber in arrival order.
 */
export interface ExtensionNotificationHub {
  /**
   * Stable sink handed to `createExtensionContext`.
   *
   * Widened from `ExtensionNotifySink` so host-internal callers can omit the
   * type and get `info`, the same default `ctx.notify` applies.
   */
  notify: (message: string, type?: ExtensionNotifyType) => void;
  /** Attach the UI. Returns an unsubscribe that re-arms buffering. */
  subscribe(listener: ExtensionNotificationListener): () => void;
}

/** Build the process-wide notification hub backing `ctx.notify`. */
export function createExtensionNotificationHub(): ExtensionNotificationHub {
  let nextId = 1;
  let listener: ExtensionNotificationListener | null = null;
  const buffered: ExtensionNotification[] = [];

  /** Hand one notification to the listener without letting a UI error reach the extension. */
  const deliver = (notification: ExtensionNotification) => {
    try {
      listener?.(notification);
    } catch {
      // A failing listener must not break the extension that called notify().
    }
  };

  return {
    notify(message: string, type: ExtensionNotifyType = "info") {
      const notification: ExtensionNotification = {
        id: nextId++,
        message: String(message),
        type,
      };

      if (listener) {
        deliver(notification);
        return;
      }

      buffered.push(notification);
      if (buffered.length > MAX_BUFFERED_NOTIFICATIONS) {
        buffered.splice(0, buffered.length - MAX_BUFFERED_NOTIFICATIONS);
      }
    },
    subscribe(nextListener: ExtensionNotificationListener) {
      listener = nextListener;
      const pending = buffered.splice(0, buffered.length);
      for (const notification of pending) {
        deliver(notification);
      }

      return () => {
        if (listener === nextListener) {
          listener = null;
        }
      };
    },
  };
}
