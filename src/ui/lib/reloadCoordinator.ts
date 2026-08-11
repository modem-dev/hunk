import { WATCH_CHECK_CANCELLED_CODE } from "../../core/watchController";
import type { ReloadSessionOptions } from "../../session/types";

/** Build the silent cancellation used when a newer reload supersedes older work. */
function createSupersededReloadError() {
  return Object.assign(new Error("A newer session reload superseded this result."), {
    name: "AbortError",
    code: WATCH_CHECK_CANCELLED_CODE,
  });
}

export interface SessionReloadAttempt {
  /** Reject work that was aborted or replaced by a newer reload. */
  assertCurrent(): void;
  /** Publish one content generation without an async gap in the ownership check. */
  publishContent<T>(publish: (contentGeneration: number) => T): T;
  /** Release any authoritative-reload priority still owned by this attempt. */
  finish(): void;
}

/**
 * Coordinate overlapping watch, manual, and daemon reloads.
 *
 * Explicit reloads are authoritative: they supersede older work and prevent a
 * retired watch controller from retrying until the replacement has settled.
 */
export function createSessionReloadCoordinator() {
  let currentReloadGeneration = 0;
  let currentContentGeneration = 0;
  let authoritativeReloadGeneration: number | null = null;

  return {
    /** Claim ownership for one reload or reject a stale watch event. */
    begin(options?: ReloadSessionOptions): SessionReloadAttempt {
      const isWatchReload = options?.reason === "watch";
      if (
        isWatchReload &&
        (options.watchContentGeneration !== currentContentGeneration ||
          authoritativeReloadGeneration !== null)
      ) {
        throw createSupersededReloadError();
      }

      const reloadGeneration = ++currentReloadGeneration;
      if (!isWatchReload) authoritativeReloadGeneration = reloadGeneration;
      let published = false;
      let finished = false;

      const assertCurrent = () => {
        if (finished) throw new Error("Cannot use a finished session reload attempt.");
        options?.signal?.throwIfAborted();
        if (reloadGeneration !== currentReloadGeneration) {
          throw createSupersededReloadError();
        }
      };

      return {
        assertCurrent,
        publishContent<T>(publish: (contentGeneration: number) => T) {
          assertCurrent();
          if (published) throw new Error("Session reload content was already published.");
          const nextContentGeneration = currentContentGeneration + 1;
          const result = publish(nextContentGeneration);
          currentContentGeneration = nextContentGeneration;
          published = true;
          return result;
        },
        finish() {
          if (finished) return;
          finished = true;
          if (authoritativeReloadGeneration === reloadGeneration) {
            authoritativeReloadGeneration = null;
          }
        },
      };
    },
  };
}
