/**
 * The view options one browser client draws with, and where each one came from.
 *
 * The terminal resolves view options through a layered chain — built-ins, user config, repo
 * config, command sections, CLI flags — and the prototype browser had none of that: it
 * hardcoded a layout and a theme and persisted nothing (`docs/browser-review-seam-audit.md`,
 * G1). What this module fixes is the half a read-only client can fix: the host's resolved
 * defaults are the starting point when it supplies them, and only the options the shared
 * classification calls per-client are resolved here at all.
 *
 * That filter is the point. `showAgentNotes` and the filter are the review's, shared by
 * every attached surface, and a client that quietly kept its own copy of one would be
 * showing a different review from the terminal beside it. Asking
 * `REVIEW_VIEW_OPTION_LOCUS` rather than assuming is what keeps that honest.
 *
 * Theme is deliberately absent: whether the browser mirrors the terminal's theme is an open
 * product decision (E2), so this client renders in Pierre's own palette and adopts nothing
 * from `src/ui/themes` by default.
 */
import { isClientReviewViewOption, REVIEW_VIEW_OPTION_LOCUS } from "../core/review/viewOptions";

/** How the browser lays a diff out; the same vocabulary the terminal's layout modes use. */
export type BrowserReviewLayout = "auto" | "split" | "stack";

export interface BrowserViewOptions {
  layout: BrowserReviewLayout;
  showLineNumbers: boolean;
  wrapLines: boolean;
  showHunkHeaders: boolean;
}

/**
 * What a browser draws with before anyone says otherwise.
 *
 * Chosen to match the terminal's own built-in defaults, so opening the same review in two
 * places does not look like two different products.
 */
export const DEFAULT_BROWSER_VIEW_OPTIONS: BrowserViewOptions = {
  layout: "auto",
  showLineNumbers: true,
  wrapLines: false,
  showHunkHeaders: true,
};

/** The host's resolved defaults, as far as they are this client's to adopt. */
export interface HostViewDefaults {
  mode?: BrowserReviewLayout;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
  showHunkHeaders?: boolean;
  /** Shared review state; accepted so a caller may pass the host's whole record. */
  showAgentNotes?: boolean;
  filter?: string;
}

/** Which host default fills which client option, named once for both directions. */
const CLIENT_OPTION_SOURCES = {
  layout: "mode",
  showLineNumbers: "showLineNumbers",
  wrapLines: "wrapLines",
  showHunkHeaders: "showHunkHeaders",
} as const satisfies Record<keyof BrowserViewOptions, keyof typeof REVIEW_VIEW_OPTION_LOCUS>;

/**
 * Resolve what this client draws with: built-in defaults, then the host's, then its own.
 *
 * A host default for an option the classification calls part of the review is ignored
 * rather than adopted locally — not because it is wrong, but because a per-client copy of
 * shared state is how two surfaces come to disagree about one review.
 */
export function resolveBrowserViewOptions(
  hostDefaults: HostViewDefaults = {},
  overrides: Partial<BrowserViewOptions> = {},
): BrowserViewOptions {
  const resolved = { ...DEFAULT_BROWSER_VIEW_OPTIONS };
  for (const [option, source] of Object.entries(CLIENT_OPTION_SOURCES) as Array<
    [keyof BrowserViewOptions, keyof typeof REVIEW_VIEW_OPTION_LOCUS]
  >) {
    if (!isClientReviewViewOption(source)) {
      continue;
    }
    const hostValue = hostDefaults[source as keyof HostViewDefaults];
    const override = overrides[option];
    const value = override ?? hostValue ?? resolved[option];
    Object.assign(resolved, { [option]: value });
  }
  return resolved;
}

/**
 * Which layout a viewport of this width draws.
 *
 * `auto` is responsive exactly as the terminal's is — wide enough for two columns means
 * two columns — and an explicit choice overrides it.
 */
export const BROWSER_SPLIT_LAYOUT_MIN_WIDTH = 1_000;

export function resolveBrowserDiffStyle(
  layout: BrowserReviewLayout,
  viewportWidth: number,
): "split" | "unified" {
  if (layout === "split") {
    return "split";
  }
  if (layout === "stack") {
    return "unified";
  }
  return viewportWidth >= BROWSER_SPLIT_LAYOUT_MIN_WIDTH ? "split" : "unified";
}
