import type { ExtensionVcsHistoryReviewAction } from "../../extension-api/types";

/** Convert a provider-owned review declaration into one option-safe internal invocation. */
export function historyReviewArgs(action: ExtensionVcsHistoryReviewAction) {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64url");
  return [action.kind === "revision-range" ? "diff" : "show", "--history-review", payload];
}
