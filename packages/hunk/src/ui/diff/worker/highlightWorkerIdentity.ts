import { createHash } from "node:crypto";
import type { HighlightWorkerRequest } from "./highlightWorkerProtocol";

const HIGHLIGHT_WORKER_CACHE_REVISION = 2;

export type HighlightWorkerCacheIdentity = HighlightWorkerRequest extends infer Request
  ? Request extends HighlightWorkerRequest
    ? Omit<Request, "id" | "version">
    : never
  : never;

/** Hash every worker-render input so compact payloads never rely on caller cache-key discipline. */
export function highlightWorkerCacheKey(input: HighlightWorkerCacheIdentity) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        revision: HIGHLIGHT_WORKER_CACHE_REVISION,
      }),
    )
    .digest("hex");
}
