/**
 * Keeps one review event stream open, reconnecting when it drops.
 *
 * The page watches its session for new publications. A stream can end because the daemon
 * restarted, the network blinked, or the session went away; this module tells those apart
 * and reconnects through the one shared scheduler (`createReconnectScheduler`,
 * `docs/browser-review-seam-audit.md`, C5) — there is no `EventSource` with a reconnect loop
 * of its own to interleave with. A fresh stream always opens with a complete publication,
 * so reconnecting needs no replay: the mirror classifies that publication like any other.
 *
 * Stops for good on a `disconnect` event (the session ended) and on a refusal that
 * retrying cannot fix (the capability no longer authorizes this session).
 */
import {
  createReconnectScheduler,
  type LifecycleTimerClock,
  type ReconnectBackoff,
} from "@hunk/session-broker-core/lifecycle";
import type { ReviewAsyncDigestFn } from "../../core/review/validation";
import { ReviewApiError, type ReviewApiClient, type ReviewApiErrorCode } from "./apiClient";
import { readReviewEvents, type ReviewStreamEvent } from "./eventReader";

/** Where the stream is, for a surface that shows connection state. */
export type ReviewEventStreamStatus =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "reconnecting"; delayMs: number; code?: ReviewApiErrorCode }
  | { kind: "ended"; reason: "disconnected" | "refused"; code?: ReviewApiErrorCode };

/** Reconnect spacing: quick first retry, doubling to a ceiling a local daemon restart fits in. */
export const REVIEW_EVENT_RECONNECT_BACKOFF: ReconnectBackoff = {
  initialDelayMs: 500,
  factor: 2,
  maxDelayMs: 8_000,
};

/** Refusals no retry can fix: the session is unreachable with this capability. */
const TERMINAL_CODES: ReadonlySet<ReviewApiErrorCode> = new Set(["unauthorized"]);

export interface ReviewEventStreamOptions {
  client: ReviewApiClient;
  onEvent: (event: ReviewStreamEvent) => void;
  onStatus?: (status: ReviewEventStreamStatus) => void;
  clock?: LifecycleTimerClock;
  backoff?: ReconnectBackoff;
  digest?: ReviewAsyncDigestFn;
}

/** One open-and-reconnecting stream; `close` stops it for good. */
export interface ReviewEventStream {
  close(): void;
}

/** Open one session's event stream and keep it open until closed or ended. */
export function openReviewEventStream(options: ReviewEventStreamOptions): ReviewEventStream {
  const scheduler = createReconnectScheduler({
    backoff: options.backoff ?? REVIEW_EVENT_RECONNECT_BACKOFF,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  let closed = false;
  let controller: AbortController | undefined;

  const report = (status: ReviewEventStreamStatus) => {
    if (!closed) options.onStatus?.(status);
  };

  const retry = (code?: ReviewApiErrorCode) => {
    if (closed) return;
    report({ kind: "reconnecting", delayMs: scheduler.nextDelayMs(), ...(code ? { code } : {}) });
    scheduler.schedule(() => void connect());
  };

  const connect = async () => {
    if (closed) return;
    controller = new AbortController();
    const { signal } = controller;
    report({ kind: "connecting" });
    let disconnected = false;
    try {
      const body = await options.client.openEvents(signal);
      report({ kind: "open" });
      await readReviewEvents(
        body,
        (event) => {
          // A delivered event proves the link works, so the next drop starts the backoff over.
          scheduler.succeeded();
          if (event.type === "disconnect") disconnected = true;
          if (!closed) options.onEvent(event);
        },
        { signal, ...(options.digest ? { digest: options.digest } : {}) },
      );
    } catch (error) {
      if (closed || signal.aborted) return;
      const code = error instanceof ReviewApiError ? error.code : undefined;
      if (code && TERMINAL_CODES.has(code)) {
        report({ kind: "ended", reason: "refused", code });
        return;
      }
      retry(code);
      return;
    }
    if (closed) return;
    if (disconnected) {
      report({ kind: "ended", reason: "disconnected" });
      return;
    }
    // The server closed the stream without a farewell: a restart or a dropped link.
    retry();
  };

  void connect();
  return {
    close() {
      closed = true;
      scheduler.cancel();
      controller?.abort();
    },
  };
}
