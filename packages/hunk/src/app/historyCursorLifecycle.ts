import type { VcsHistorySource } from "../core/vcs/types";

/** Replace history cursors on refresh and drain late opens and cleanup on close. */
export function createHistoryCursorLifecycle(
  initialSource: VcsHistorySource,
  open: (signal?: AbortSignal) => Promise<VcsHistorySource>,
) {
  let source = initialSource;
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const pending = new Set<Promise<VcsHistorySource>>();
  const closures = new WeakMap<VcsHistorySource, Promise<void>>();
  let cleanupFailure: { error: unknown } | undefined;

  /** Coalesce cursor disposal even when shutdown races an in-flight refresh. */
  const closeSource = (cursor: VcsHistorySource) => {
    let closed = closures.get(cursor);
    if (!closed) {
      // Claim provider cleanup before an aborted read can reach EOF and close the same cursor.
      // Deferring this call loses its rejection when the provider's second close is a no-op.
      try {
        closed = Promise.resolve(cursor.close());
      } catch (error) {
        closed = Promise.reject(error);
      }
      closed = closed.catch((error: unknown) => {
        cleanupFailure ??= { error };
        throw error;
      });
      closures.set(cursor, closed);
    }
    return closed;
  };

  return {
    /** Publish only a still-current replacement; retire every abandoned cursor. */
    reopenSource(signal?: AbortSignal) {
      const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const refresh = (async () => {
        if (closing) throw new Error("History session is closed.");
        active.throwIfAborted();
        const previous = source;
        const replacement = await open(active);
        if (active.aborted || source !== previous) {
          await closeSource(replacement);
          active.throwIfAborted();
          throw new Error("History session changed while refreshing.");
        }
        source = replacement;
        await closeSource(previous);
        return replacement;
      })();
      pending.add(refresh);
      void refresh.then(
        () => pending.delete(refresh),
        () => pending.delete(refresh),
      );
      return refresh;
    },

    /** Revoke opens synchronously, then wait for active and late cursor disposal. */
    close() {
      if (!closing) {
        lifetime.abort(new Error("History session is closed."));
        const activeClose = closeSource(source);
        closing = (async () => {
          await Promise.allSettled([activeClose, ...pending]);
          // Refresh cancellation is expected; disposal failures still belong to teardown even
          // when the failed cursor has retired or its refresh promise has already settled.
          if (cleanupFailure) throw cleanupFailure.error;
        })();
      }
      return closing;
    },
  };
}
