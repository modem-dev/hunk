/** Builds review-reload controls that expire with their originating review generation. */

import type {
  ExtensionReviewReloadControls,
  ExtensionReviewReloadResult,
} from "../../extension-api/types";

const EXPIRED_RELOAD_RESULT: ExtensionReviewReloadResult = Object.freeze({
  ok: false,
  reason: "unavailable",
  detail: "This review reload request is no longer current.",
});

/** Guard one host-owned reload operation behind a review-generation capability lease. */
export function createExtensionReviewReloadControls({
  isLive,
  requestReload,
}: {
  isLive: () => boolean;
  requestReload: () => Promise<ExtensionReviewReloadResult>;
}): ExtensionReviewReloadControls {
  return Object.freeze({
    requestReload() {
      if (!isLive()) return Promise.resolve(EXPIRED_RELOAD_RESULT);
      return requestReload();
    },
  });
}
