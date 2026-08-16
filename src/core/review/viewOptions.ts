/**
 * Which view options belong to the review and which belong to one client.
 *
 * With a terminal, a browser, and agents attached to one session, every option has to
 * answer a question nobody had to ask while there was only a terminal: if I change this,
 * does it change for everyone? The prototype answered it by accident — an option was
 * shared if it happened to be read from shared state and per-client if it happened to be
 * read from a local hook — and the browser then hardcoded its own defaults for the rest
 * (`docs/browser-review-seam-audit.md`, G1). The classification is stated here instead,
 * once, so both clients agree on what an option means before either renders it.
 *
 * The rule behind the table: an option is `review` when it changes what the review *is
 * about* — which files are in view, whether their agent context is part of the reading —
 * and `client` when it changes only how one screen draws it. Two people reading one review
 * on two screens expect to see the same files; they do not expect one to be forced into
 * the other's colors, column layout, or window size.
 *
 * This module classifies. It resolves nothing: reading user config, repo config, and CLI
 * flags is the host's layered chain (`src/core/config.ts`), and a client's own overrides
 * are its own storage.
 */
import type { PersistedViewPreferences } from "../types";

/**
 * How a surface lays a diff out.
 *
 * One vocabulary for both tiers: `auto` is responsive — two columns when there is room for
 * them — and an explicit choice overrides it. It lives with the option classification
 * because a layout is one of the options being classified, and a browser that declared its
 * own three-word union would be free to drift from the terminal's on what `auto` means.
 */
export type LayoutMode = "auto" | "split" | "stack";

/**
 * Where one option's value lives.
 *
 * - `review` — part of the review every attached surface sees; changing it is a review
 *   action, and the producer broadcasts the result.
 * - `client` — one surface's own view of that review; changing it reaches nobody else.
 */
export type ReviewViewOptionLocus = "review" | "client";

/**
 * Every option a review surface carries, and where its value lives.
 *
 * Keyed over `PersistedViewPreferences` plus `filter`, which is review state rather than a
 * persisted preference but is exactly the kind of option this table exists to classify.
 * Totality is mechanical: an option added to the preferences without a locus fails to
 * typecheck here rather than being silently treated as per-client by whichever surface
 * reads it first.
 */
export const REVIEW_VIEW_OPTION_LOCUS: Record<
  keyof PersistedViewPreferences | "filter",
  ReviewViewOptionLocus
> = {
  // What the review is about.
  filter: "review",
  showAgentNotes: "review",
  // How one screen draws it.
  mode: "client",
  theme: "client",
  showLineNumbers: "client",
  wrapLines: "client",
  showHunkHeaders: "client",
  showMenuBar: "client",
  copyDecorations: "client",
  cursorLine: "client",
};

/** The options one client may set for itself without changing anyone else's review. */
export type ClientReviewViewOption = {
  [Key in keyof typeof REVIEW_VIEW_OPTION_LOCUS]: (typeof REVIEW_VIEW_OPTION_LOCUS)[Key] extends "client"
    ? Key
    : never;
}[keyof typeof REVIEW_VIEW_OPTION_LOCUS];

/** Whether one option is this client's own to change. */
export function isClientReviewViewOption(
  option: keyof typeof REVIEW_VIEW_OPTION_LOCUS,
): option is ClientReviewViewOption {
  return REVIEW_VIEW_OPTION_LOCUS[option] === "client";
}
