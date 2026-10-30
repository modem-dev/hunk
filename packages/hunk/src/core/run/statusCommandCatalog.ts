import { builtinAppCommand } from "./commandCatalog";

/** Declare read-only status actions using shared app identities for theme, help and quit. */
export const STATUS_COMMAND_CATALOG = [
  {
    id: "hunk.status.openSelection",
    title: "Open selected path / inspect worktree / toggle file group",
    defaultKeys: ["enter"],
  },
  {
    id: "hunk.status.togglePathGroup",
    title: "Expand / collapse selected file group",
    defaultKeys: ["space"],
  },
  { id: "hunk.status.reviewStaged", title: "Review staged changes", defaultKeys: ["s"] },
  { id: "hunk.status.reviewUnstaged", title: "Review unstaged changes", defaultKeys: ["u"] },
  { id: "hunk.status.openLog", title: "Open log", defaultKeys: ["l"] },
  { id: "hunk.status.refresh", title: "Refresh status", defaultKeys: ["r"] },
  {
    id: "hunk.status.back",
    title: "Back to originating worktree",
    defaultKeys: ["escape", "backspace"],
  },
  { id: "hunk.status.previousRow", title: "Previous row", defaultKeys: ["up", "k"] },
  { id: "hunk.status.nextRow", title: "Next row", defaultKeys: ["down", "j"] },
  { id: "hunk.status.pageUp", title: "Page up", defaultKeys: ["pageup"] },
  { id: "hunk.status.pageDown", title: "Page down", defaultKeys: ["pagedown"] },
  {
    id: "hunk.status.toggleWorktrees",
    title: "Expand / collapse other worktrees",
    defaultKeys: ["w"],
  },
  { ...builtinAppCommand("hunk.view.openThemeSelector"), id: "hunk.view.openThemeSelector" },
  { ...builtinAppCommand("hunk.app.toggleHelp"), id: "hunk.app.toggleHelp" },
  { ...builtinAppCommand("hunk.app.quit"), id: "hunk.app.quit" },
] as const;
export type StatusCommandId = (typeof STATUS_COMMAND_CATALOG)[number]["id"];

export const STATUS_COMMAND_NAMES: ReadonlySet<string> = new Set(
  STATUS_COMMAND_CATALOG.map((entry) => entry.id),
);
