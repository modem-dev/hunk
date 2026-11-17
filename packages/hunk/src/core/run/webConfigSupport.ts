/**
 * Classifies every config option for the browser review page.
 *
 * Every key in `CONFIG_REFERENCE_OPTIONS` (`./config.ts`) is classified here in one record keyed
 * by `ConfigOptionKey`, so an option added to the table fails to typecheck until someone decides
 * what the page does with it:
 *
 * - `published` — the host sends the resolved value to the page as a session default
 *   (`ReviewPresentationDefaults`, built by `app/review/sharedState.ts`), and `field` names where
 *   it lands. The page starts from it unless this browser stored its own choice. `applied: false`
 *   marks a value the page receives but cannot act on yet, with the reason.
 * - `host-side` — it changes the review's input or seeds shared review state, so both surfaces
 *   see the result without the page reading the option.
 * - `terminal-only` — it tunes a terminal mechanism the page has no counterpart for, or one the
 *   browser provides natively.
 * - `deferred` — the page should honor it and cannot yet, with the reason.
 *
 * The host projection reads `WebPublishedViewField` so its `view` block carries exactly the
 * published view fields, and `app/review/sharedState.test.ts` checks the built defaults against
 * this record in both directions. Reasons are one plain sentence each.
 */
import type { ConfigOptionKey } from "./config";

/** Where a published option lands in the presentation defaults a session sends the page. */
export type WebPublishedField = "theme" | `view.${string}`;

/** What the browser page does with one config option. */
export type WebConfigSupport =
  | { kind: "published"; field: WebPublishedField; applied: true }
  | { kind: "published"; field: WebPublishedField; applied: false; reason: string }
  | { kind: "host-side"; reason: string }
  | { kind: "terminal-only"; reason: string }
  | { kind: "deferred"; reason: string };

/** The host sends it and the page applies it. */
function published<const Field extends WebPublishedField>(field: Field) {
  return { kind: "published", field, applied: true } as const;
}

/** The host sends it, but the page cannot act on it yet. */
function publishedUnapplied<const Field extends WebPublishedField>(field: Field, reason: string) {
  return { kind: "published", field, applied: false, reason } as const;
}

/** Changes the review's input or shared state; both surfaces see the result. */
function hostSide(reason: string) {
  return { kind: "host-side", reason } as const;
}

/** Tunes a terminal mechanism the page has no counterpart for. */
function terminalOnly(reason: string) {
  return { kind: "terminal-only", reason } as const;
}

/** The page should honor it and cannot yet. */
function deferred(reason: string) {
  return { kind: "deferred", reason } as const;
}

/** The page's decision for every config option, in config reference order. */
export const WEB_CONFIG_SUPPORT = {
  mode: published("view.layout"),
  auto_split_min_width: published("view.autoSplitMinWidth"),
  cursor_line: terminalOnly(
    "The page has no line cursor; it selects hunks and leaves text selection to the browser.",
  ),
  vcs: hostSide("The host picks the adapter that loads the changeset both surfaces show."),
  theme: published("theme"),
  watch: hostSide("The host reloads the review, and the page follows the new generation."),
  exclude_untracked: hostSide("The host leaves untracked files out of the changeset it loads."),
  line_numbers: published("view.lineNumbers"),
  tab_width: published("view.tabWidth"),
  file_gap: terminalOnly("It spaces terminal rows; the page lays out files with its own styles."),
  hunk_gap: terminalOnly("It spaces terminal rows; the page lays out hunks with its own styles."),
  scroll_off: terminalOnly("It keeps the terminal's line cursor off the edge; the page has none."),
  wheel_scroll_lines: terminalOnly("The browser scrolls the page with its own wheel settings."),
  wrap_lines: published("view.wrapLines"),
  hunk_headers: publishedUnapplied(
    "view.hunkHeaders",
    "The page cannot hide hunk header rows until its renderer can omit them.",
  ),
  menu_bar: terminalOnly("The page has its own toolbar and no terminal menu bar."),
  animations: terminalOnly(
    "The page follows the browser's prefers-reduced-motion setting, its native equivalent.",
  ),
  sidebar: published("view.sidebar"),
  agent_notes: hostSide("It seeds the shared note visibility that every surface reads."),
  copy_decorations: terminalOnly(
    "The browser copies its own native selection, which this option does not shape.",
  ),
  prompt_save_view_preferences: terminalOnly(
    "The page keeps view changes per browser and never writes them to config.",
  ),
  transparent_background: terminalOnly(
    "It lets the terminal's background show through; the page paints its own.",
  ),
  color_moved: deferred(
    "The host sends moved-line marks, but the page cannot paint them until Pierre has a per-line decoration hook.",
  ),
} as const satisfies Record<ConfigOptionKey, WebConfigSupport>;

/** The presentation field one published option lands in. */
type WebPublishedEntry = Extract<
  (typeof WEB_CONFIG_SUPPORT)[ConfigOptionKey],
  { kind: "published" }
>["field"];

/** Every `view` field a session sends, by name, e.g. `tabWidth`. */
export type WebPublishedViewField = WebPublishedEntry extends infer Field
  ? Field extends `view.${infer Name}`
    ? Name
    : never
  : never;
