import {
  builtinAppCommand,
  type AppCommandCatalogEntry,
  type AppCommandId,
} from "./commandCatalog";

/** The menu and help groups used to present one history command. */
export type HistoryCommandGroup = "file" | "view" | "navigate" | "commit" | "help";
export type HistoryCommandHelpSection = "Navigation" | "Commit" | "Application";

/** Renderer-neutral identity plus history-surface presentation metadata. */
export interface HistoryCommandCatalogEntry extends AppCommandCatalogEntry {
  group: HistoryCommandGroup;
  helpSection?: HistoryCommandHelpSection;
}

/** Reuse one shared app/view identity while assigning it to history chrome. */
function sharedHistoryCommand<const Id extends AppCommandId>(
  id: Id,
  group: HistoryCommandGroup,
  helpSection?: HistoryCommandHelpSection,
): HistoryCommandCatalogEntry & { id: Id } {
  return {
    ...builtinAppCommand(id),
    group,
    ...(helpSection ? { helpSection } : {}),
  } as HistoryCommandCatalogEntry & { id: Id };
}

/**
 * Declares every command available on the interactive history surface.
 *
 * Shared app/view commands retain their existing identities. Commit traversal and
 * presentation use `hunk.history.*` ids because matching chords do not make their effects
 * equivalent to review commands.
 */
const HISTORY_COMMANDS = [
  {
    id: "hunk.history.openSelection",
    title: "Open selection",
    category: "history",
    defaultKeys: ["enter"],
    locus: "host-only",
    publicToExtensions: false,
    group: "file",
    helpSection: "Commit",
  },
  {
    id: "hunk.history.copyRevision",
    title: "Copy commit ID",
    category: "history",
    defaultKeys: ["y"],
    locus: "client-local",
    publicToExtensions: false,
    group: "file",
    helpSection: "Commit",
  },
  {
    id: "hunk.history.refresh",
    title: "Refresh history",
    category: "history",
    defaultKeys: ["r"],
    locus: "host-only",
    publicToExtensions: false,
    group: "file",
    helpSection: "Application",
  },
  {
    ...sharedHistoryCommand("hunk.app.quit", "file", "Application"),
    // Interactive history owns Ctrl-C so it can cancel provider planning before quitting.
    defaultKeys: ["q", "ctrl+c"],
  },
  sharedHistoryCommand("hunk.view.openThemeSelector", "view", "Application"),
  {
    id: "hunk.history.toggleGraph",
    title: "Graph view",
    category: "history",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: false,
    group: "view",
  },
  {
    id: "hunk.history.toggleUnicode",
    title: "Unicode lines",
    category: "history",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: false,
    group: "view",
  },
  {
    id: "hunk.history.toggleAuthor",
    title: "Show author",
    category: "history",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: false,
    group: "view",
  },
  {
    id: "hunk.history.toggleDate",
    title: "Show date",
    category: "history",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: false,
    group: "view",
  },
  {
    id: "hunk.history.toggleDecorations",
    title: "Show decorations",
    category: "history",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: false,
    group: "view",
  },
  {
    id: "hunk.history.startVisualSelection",
    title: "Start visual selection",
    category: "history",
    defaultKeys: ["v"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.clearSelection",
    title: "Clear selection",
    category: "history",
    defaultKeys: ["escape"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.extendPrevious",
    title: "Extend selection up",
    category: "history",
    defaultKeys: ["shift+up", "K"],
    locus: "client-local",
    verticalDirection: -1,
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.extendNext",
    title: "Extend selection down",
    category: "history",
    defaultKeys: ["shift+down", "J"],
    locus: "client-local",
    verticalDirection: 1,
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.previousCommit",
    title: "Previous commit",
    category: "history",
    defaultKeys: ["up", "k"],
    locus: "client-local",
    verticalDirection: -1,
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.nextCommit",
    title: "Next commit",
    category: "history",
    defaultKeys: ["down", "j"],
    locus: "client-local",
    verticalDirection: 1,
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.pageUp",
    title: "Page up",
    category: "history",
    defaultKeys: ["pageup", "b", "shift+space"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.pageDown",
    title: "Page down",
    category: "history",
    defaultKeys: ["pagedown", "space", "f"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.halfPageUp",
    title: "Half page up",
    category: "history",
    defaultKeys: ["u", "ctrl+u"],
    locus: "client-local",
    verticalDirection: -1,
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.halfPageDown",
    title: "Half page down",
    category: "history",
    defaultKeys: ["d", "ctrl+d"],
    locus: "client-local",
    verticalDirection: 1,
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.jumpToFirst",
    title: "First commit",
    category: "history",
    defaultKeys: ["home", "g"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.jumpToLast",
    title: "Last commit",
    category: "history",
    defaultKeys: ["end", "G"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.search",
    title: "Search…",
    category: "history",
    defaultKeys: ["/"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.nextMatch",
    title: "Next match",
    category: "history",
    defaultKeys: ["n"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.previousMatch",
    title: "Previous match",
    category: "history",
    defaultKeys: ["N"],
    locus: "client-local",
    publicToExtensions: false,
    group: "navigate",
    helpSection: "Navigation",
  },
  {
    id: "hunk.history.openFirstParent",
    title: "Compare with first parent",
    category: "history",
    defaultKeys: [],
    locus: "host-only",
    publicToExtensions: false,
    group: "commit",
  },
  {
    id: "hunk.history.openParent",
    title: "Compare with parent…",
    category: "history",
    defaultKeys: [],
    locus: "host-only",
    publicToExtensions: false,
    group: "commit",
  },
  sharedHistoryCommand("hunk.app.toggleHelp", "help", "Application"),
  {
    id: "hunk.history.showAbout",
    title: "About Hunk",
    category: "history",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: false,
    group: "help",
  },
] as const satisfies readonly HistoryCommandCatalogEntry[];

/** Every canonical command id available in interactive history. */
export type HistoryCommandId = (typeof HISTORY_COMMANDS)[number]["id"];

export const HISTORY_COMMAND_CATALOG: readonly HistoryCommandCatalogEntry[] = HISTORY_COMMANDS;

/** Canonical and compatibility names accepted for history-surface built-ins. */
export const HISTORY_COMMAND_NAMES: ReadonlySet<string> = new Set(
  HISTORY_COMMAND_CATALOG.flatMap((entry) => [entry.id, ...(entry.aliases ?? [])]),
);

/** Look up one history command by canonical id or compatibility alias. */
export function historyCommandCatalogEntry(id: string): HistoryCommandCatalogEntry | undefined {
  return HISTORY_COMMAND_CATALOG.find((entry) => entry.id === id || entry.aliases?.includes(id));
}
