import type { KeyEvent } from "@opentui/core";
import type { HelpSection } from "../lib/helpContent";
import type { MenuId } from "../components/chrome/menu";
import type { LogSnapshot } from "./controller";

export type LogCommandId =
  | "open"
  | "copy"
  | "refresh"
  | "quit"
  | "theme"
  | "toggle-graph"
  | "toggle-unicode"
  | "toggle-author"
  | "toggle-date"
  | "toggle-decorations"
  | "previous"
  | "next"
  | "page-up"
  | "page-down"
  | "first"
  | "last"
  | "search"
  | "next-match"
  | "previous-match"
  | "open-first-parent"
  | "open-parent"
  | "help"
  | "about";

type Shortcut = { token: string; display: string };

export interface LogCommandDefinition {
  id: LogCommandId;
  label: string;
  menu: MenuId;
  shortcuts?: readonly Shortcut[];
  helpSection?: "Navigation" | "Commit" | "Application";
}

/** Define log labels and bindings once for keyboard dispatch, menus, and help. */
export const LOG_COMMANDS: readonly LogCommandDefinition[] = [
  {
    id: "open",
    label: "Open selected commit",
    menu: "file",
    shortcuts: [{ token: "name:enter", display: "Enter" }],
    helpSection: "Commit",
  },
  {
    id: "copy",
    label: "Copy commit ID",
    menu: "file",
    shortcuts: [{ token: "sequence:y", display: "y" }],
    helpSection: "Commit",
  },
  {
    id: "refresh",
    label: "Refresh history",
    menu: "file",
    shortcuts: [{ token: "sequence:r", display: "r" }],
    helpSection: "Application",
  },
  {
    id: "quit",
    label: "Quit",
    menu: "file",
    shortcuts: [
      { token: "sequence:q", display: "q" },
      { token: "ctrl:c", display: "Ctrl-C" },
    ],
    helpSection: "Application",
  },
  { id: "theme", label: "Theme…", menu: "view" },
  { id: "toggle-graph", label: "Graph", menu: "view" },
  { id: "toggle-unicode", label: "Unicode graph", menu: "view" },
  { id: "toggle-author", label: "Show author", menu: "view" },
  { id: "toggle-date", label: "Show date", menu: "view" },
  { id: "toggle-decorations", label: "Show decorations", menu: "view" },
  {
    id: "previous",
    label: "Previous commit",
    menu: "navigate",
    shortcuts: [
      { token: "name:up", display: "↑ / k" },
      { token: "sequence:k", display: "↑ / k" },
    ],
    helpSection: "Navigation",
  },
  {
    id: "next",
    label: "Next commit",
    menu: "navigate",
    shortcuts: [
      { token: "name:down", display: "↓ / j" },
      { token: "sequence:j", display: "↓ / j" },
    ],
    helpSection: "Navigation",
  },
  {
    id: "page-up",
    label: "Page up",
    menu: "navigate",
    shortcuts: [{ token: "name:pageup", display: "PgUp" }],
    helpSection: "Navigation",
  },
  {
    id: "page-down",
    label: "Page down",
    menu: "navigate",
    shortcuts: [{ token: "name:pagedown", display: "PgDn" }],
    helpSection: "Navigation",
  },
  {
    id: "first",
    label: "First commit",
    menu: "navigate",
    shortcuts: [
      { token: "name:home", display: "Home / g" },
      { token: "sequence:g", display: "Home / g" },
    ],
    helpSection: "Navigation",
  },
  {
    id: "last",
    label: "Last commit",
    menu: "navigate",
    shortcuts: [
      { token: "name:end", display: "End / G" },
      { token: "sequence:G", display: "End / G" },
    ],
    helpSection: "Navigation",
  },
  {
    id: "search",
    label: "Search…",
    menu: "navigate",
    shortcuts: [{ token: "sequence:/", display: "/" }],
    helpSection: "Navigation",
  },
  {
    id: "next-match",
    label: "Next match",
    menu: "navigate",
    shortcuts: [{ token: "sequence:n", display: "n" }],
    helpSection: "Navigation",
  },
  {
    id: "previous-match",
    label: "Previous match",
    menu: "navigate",
    shortcuts: [{ token: "sequence:N", display: "N" }],
    helpSection: "Navigation",
  },
  {
    id: "open-first-parent",
    label: "Compare with first parent",
    menu: "commit",
  },
  { id: "open-parent", label: "Compare with parent…", menu: "commit" },
  {
    id: "help",
    label: "Keyboard shortcuts",
    menu: "help",
    shortcuts: [{ token: "sequence:?", display: "?" }],
    helpSection: "Application",
  },
  { id: "about", label: "About Hunk", menu: "help" },
];

const BY_ID = new Map(LOG_COMMANDS.map((command) => [command.id, command]));

/** Return the canonical definition for one command. */
export function logCommand(id: LogCommandId) {
  return BY_ID.get(id)!;
}

/** Derive one menu/help hint from the same shortcuts used for dispatch. */
export function logCommandHint(id: LogCommandId) {
  return logCommand(id).shortcuts?.[0]?.display;
}

/** Resolve a keyboard event to the canonical log command. */
export function matchLogCommand(key: KeyEvent): LogCommandId | null {
  const tokens = [
    key.ctrl ? `ctrl:${key.name}` : "",
    `name:${key.name === "return" ? "enter" : key.name}`,
    key.sequence ? `sequence:${key.sequence}` : "",
  ];
  return (
    LOG_COMMANDS.find((command) =>
      command.shortcuts?.some((shortcut) => tokens.includes(shortcut.token)),
    )?.id ?? null
  );
}

/** Apply context-sensitive availability consistently to keyboard and menus. */
export function isLogCommandEnabled(id: LogCommandId, snapshot: LogSnapshot) {
  const selected = snapshot.rows[snapshot.selected];
  if (["open", "copy"].includes(id)) return Boolean(selected);
  if (id === "previous" || id === "page-up" || id === "first") return snapshot.selected > 0;
  if (id === "next" || id === "page-down" || id === "last")
    return !(snapshot.historyDone && snapshot.selected >= snapshot.rows.length - 1);
  if (id === "next-match" || id === "previous-match") return Boolean(snapshot.search);
  if (id === "open-first-parent") return Boolean(selected?.commit.parentRevisionIds.length);
  if (id === "open-parent") return (selected?.commit.parentRevisionIds.length ?? 0) > 1;
  return true;
}

/** Build log help from the same labels and bindings used by dispatch and menus. */
export function buildLogHelpSections(): readonly HelpSection[] {
  const order: NonNullable<LogCommandDefinition["helpSection"]>[] = [
    "Navigation",
    "Commit",
    "Application",
  ];
  return order.map((title) => ({
    title,
    rows: LOG_COMMANDS.filter((command) => command.helpSection === title).map((command) => ({
      keys: command.shortcuts?.[0]?.display ?? "",
      description: command.label.toLocaleLowerCase(),
    })),
  }));
}
