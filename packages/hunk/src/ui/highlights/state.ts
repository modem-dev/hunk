import { lineHighlighterKey, qualifiedViewKey } from "../../extensions/apply";
import type { RegisteredLineHighlighter } from "../../extensions/types";
import type { ScopedEpochState } from "../lib/scopedEpochs";

/**
 * Invalidation counters for prepared line highlights, keyed by registered
 * highlighter and optionally narrowed to one reviewed file.
 *
 * The same scoped-epoch policy file views use (`packages/hunk/src/ui/lib/scopedEpochs.ts`):
 * `ctx.highlights.refresh` bumps an epoch, and preparation re-derives exactly
 * the invalidated `(file, highlighter)` results.
 */
export type LineHighlightEpochState = ScopedEpochState;

/** Resolve one registered highlighter key as `<extensionId>:<highlighterId>`. */
export function registeredLineHighlighterKey(registered: RegisteredLineHighlighter) {
  // Preparation retention and refresh targeting must agree, so both derive
  // the key from the same policy duplicate resolution uses.
  return lineHighlighterKey(registered);
}

/** Resolve a bare local or qualified highlighter id without reserving extension ids. */
export function resolveRegisteredLineHighlighter(
  highlighters: readonly RegisteredLineHighlighter[],
  extensionId: string,
  highlighterId: string,
) {
  const key = highlighterId.includes(":")
    ? highlighterId
    : qualifiedViewKey(extensionId, highlighterId);
  return highlighters.find((registered) => registeredLineHighlighterKey(registered) === key);
}
