import { createHash } from "node:crypto";
import type { FileDiffMetadata } from "@pierre/diffs";

const HIGHLIGHT_WORKER_CACHE_REVISION = 1;

/** Hash every worker-render input so compact payloads never rely on caller cache-key discipline. */
export function highlightWorkerCacheKey({
  aliasContext,
  appearance,
  language,
  metadata,
  theme,
}: {
  aliasContext: boolean;
  appearance: "dark" | "light";
  language: string;
  metadata: FileDiffMetadata;
  theme: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        aliasContext,
        appearance,
        language,
        metadata,
        revision: HIGHLIGHT_WORKER_CACHE_REVISION,
        theme,
      }),
    )
    .digest("hex");
}
