/**
 * Declares the page's own commands: what only a browser page can do, under `hunk.web.*` ids.
 *
 * The rule: a command that means the same thing in the terminal belongs in the shared
 * catalog (`core/run/commandCatalog.ts`) and is classified in `webCommandTable.ts`; only a
 * command with no terminal meaning — the palette and go-to-file dialogs, copying a link, the
 * per-browser theme override, the files panel's mode — is declared here. These ids never enter
 * the catalog, the host's keymap, or a review action. The palette, the help overlay, and the
 * page's keyboard read this list beside the catalog, so a command is declared once.
 *
 * The two dialog chords are deliberate browser chords (Ctrl/Cmd+K, Ctrl/Cmd+P): the catalog's
 * grammar masks every modified chord on the page so the browser keeps its shortcuts, and these
 * two are the exceptions the page claims, matched here rather than through the catalog keymap.
 * A page command may also declare plain `keys` in the shared chord grammar (the side panel's
 * `p`); those bind through the page's keymap like catalog chords and must not collide with a
 * catalog default (`webLocalCommands.test.ts`).
 */

/** Where a page command is grouped in the palette and help. */
export type WebLocalCommandCategory = "app" | "review" | "view";

/** One page-only command. */
export interface WebLocalCommand {
  id: `hunk.web.${string}`;
  title: string;
  category: WebLocalCommandCategory;
  /** A Ctrl (Cmd on macOS) chord the page claims from the browser. */
  modKey?: string;
  /** Plain chords in the shared grammar, bound through the page's keymap. */
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
    id: "hunk.web.togglePreview",
    title: "Toggle the rendered view of the selected file",
    category: "view",
  },
] as const satisfies readonly WebLocalCommand[];

/** Every page-only command id. */
export type WebLocalCommandId = (typeof WEB_LOCAL_COMMANDS)[number]["id"];

/** True on Apple platforms, where the page's chords use Cmd instead of Ctrl. */
export function isApplePlatform(platform = globalThis.navigator?.platform ?? "") {
  return /Mac|iPhone|iPad/.test(platform);
}

/** The label of one page chord, in the platform's spelling. */
export function webModChordLabel(key: string, apple = isApplePlatform()) {
  return apple ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

/** The page command a modified key event claims, if any. */
export function matchWebLocalChord(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): WebLocalCommandId | undefined {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || event.altKey || event.shiftKey) return undefined;
  const key = event.key.toLowerCase();
  const command = WEB_LOCAL_COMMANDS.find(
    (candidate) => "modKey" in candidate && candidate.modKey === key,
  );
  return command?.id;
}
