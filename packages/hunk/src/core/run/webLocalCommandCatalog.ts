/**
 * Declares the browser review page's own commands: what only a page can do, under `hunk.web.*`.
 *
 * The rule: a command that means the same thing in the terminal belongs in the shared catalog
 * (`./commandCatalog.ts`); only a command with no terminal meaning — the palette and go-to-file
 * dialogs, copying a link, the per-browser theme override, the files panel's mode, the viewed
 * marks — is declared here. These ids never enter that catalog or lower to a review action.
 *
 * The declaration lives in `core/run` rather than beside the page because the host reads it too:
 * a `[keybindings]` entry names a page command by id, so the host has to know the id to accept
 * the entry, and has to fold it into the keymap a review publishes for the page to obey it
 * (`app/review/sharedState.ts`). Terminal surfaces read only the names, to recognize an entry
 * as another surface's command instead of reporting a typo; nothing here binds in a terminal.
 *
 * A page command's shortcut is one of two kinds:
 *
 * - `keys` — plain chords in the shared grammar. They resolve with every other binding, so a
 *   remap, an unbind, and the exclusivity rule apply to them, and a command declared without
 *   `keys` ships unbound and takes a chord from `[keybindings]` like any other.
 * - `modKey` — a Ctrl (Cmd on macOS) chord the page claims from the browser. The shared
 *   grammar leaves every modified chord to the browser on a page, so these two are matched by
 *   the page itself and are not remappable.
 *
 * This module stays import-free so the browser bundle can read it
 * (`scripts/quality/source-boundaries.test.ts`).
 */

/** Where a page command is grouped in the palette and help. */
export type WebLocalCommandCategory = "app" | "review" | "view";

/** One page-only command. */
export interface WebLocalCommand {
  id: `hunk.web.${string}`;
  title: string;
  category: WebLocalCommandCategory;
  /** A Ctrl (Cmd on macOS) chord the page claims from the browser; not remappable. */
  modKey?: string;
  /** Plain chords in the shared grammar the command ships with; absent means unbound. */
  keys?: readonly string[];
}

export const WEB_LOCAL_COMMANDS = [
  { id: "hunk.web.commandPalette", title: "Command palette", category: "app", modKey: "k" },
  { id: "hunk.web.goToFile", title: "Go to file", category: "review", modKey: "p" },
  // Both links carry this tab's capability, so their titles say they include the access key,
  // matching the toolbar's "Copy link" tooltip.
  {
    id: "hunk.web.copyReviewLink",
    title: "Copy review link (includes access key)",
    category: "app",
  },
  {
    id: "hunk.web.copyLocationLink",
    title: "Copy link to this hunk or note (includes access key)",
    category: "review",
  },
  { id: "hunk.web.useSessionTheme", title: "Use session theme", category: "view" },
  { id: "hunk.web.filesAsTree", title: "Show files as a tree", category: "view" },
  { id: "hunk.web.filesAsList", title: "Show files as a flat list", category: "view" },
  { id: "hunk.web.toggleSidePanel", title: "Toggle the side panel", category: "view", keys: ["p"] },
  { id: "hunk.web.showOverview", title: "Show the review overview", category: "view", keys: ["O"] },
  {
    id: "hunk.web.showNotes",
    title: "Show every note in the review",
    category: "view",
    keys: ["N"],
  },
  { id: "hunk.web.toggleMinimap", title: "Toggle the minimap", category: "view" },
  {
    id: "hunk.web.toggleViewed",
    title: "Mark the selected file viewed, or clear its mark",
    category: "review",
    keys: ["V"],
  },
  { id: "hunk.web.toggleHideViewed", title: "Hide or show viewed files", category: "view" },
  {
    id: "hunk.web.togglePreview",
    title: "Toggle the rendered view of the selected file",
    category: "view",
  },
] as const satisfies readonly WebLocalCommand[];

/** Every page-only command id. */
export type WebLocalCommandId = (typeof WEB_LOCAL_COMMANDS)[number]["id"];

/** One remappable page command's shipped chords, in the shape the keymap resolver folds. */
export interface WebLocalCommandKeyDefaults {
  id: WebLocalCommandId;
  defaultKeys: readonly string[];
}

/**
 * The page commands `[keybindings]` may remap, with the plain chords each ships with.
 *
 * The host folds these beside the shared catalog when it resolves the keymap a review publishes;
 * the page falls back to them for a host that published none.
 */
export const WEB_LOCAL_COMMAND_KEY_DEFAULTS: readonly WebLocalCommandKeyDefaults[] =
  WEB_LOCAL_COMMANDS.flatMap((command): WebLocalCommandKeyDefaults[] =>
    "modKey" in command
      ? []
      : [{ id: command.id, defaultKeys: "keys" in command ? command.keys : [] }],
  );

/** Recognize remappable page commands on terminal surfaces without binding anything there. */
export const WEB_LOCAL_COMMAND_NAMES: ReadonlySet<string> = new Set(
  WEB_LOCAL_COMMAND_KEY_DEFAULTS.map((entry) => entry.id),
);

/** The page commands whose Ctrl/Cmd chord the page claims from the browser and never remaps. */
export const WEB_LOCAL_FIXED_COMMAND_NAMES: ReadonlySet<string> = new Set(
  WEB_LOCAL_COMMANDS.flatMap((command) => ("modKey" in command ? [command.id] : [])),
);
