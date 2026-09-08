import type { KeyEvent } from "@opentui/core";
import {
  HISTORY_COMMAND_CATALOG,
  type HistoryCommandCatalogEntry,
  type HistoryCommandHelpSection,
  type HistoryCommandId,
} from "../../core/run/historyCommandCatalog";
import { matchesAnyKeyChord } from "../../lib/commandKeys";
import type { HelpSection } from "../lib/helpContent";
import { formatKeyChord, type CommandKeyDefaults } from "../lib/keymap";
import type { AppCommand, ResolvedCommandKeys } from "../lib/appCommands";
import type { LogSnapshot } from "./controller";

export type { HistoryCommandId } from "../../core/run/historyCommandCatalog";

/** What each canonical history command does in the terminal history surface. */
export type HistoryCommandHandlers = Record<
  HistoryCommandId,
  (key: KeyEvent, entry: HistoryCommandCatalogEntry) => void
>;

export interface BuildHistoryCommandsOptions {
  getSnapshot: () => LogSnapshot;
  handlers: HistoryCommandHandlers;
  resolvedKeys?: ResolvedCommandKeys;
}

/** Return the history command defaults consumed by shared keymap resolution. */
export function historyCommandKeyDefaults(): readonly CommandKeyDefaults[] {
  return HISTORY_COMMAND_CATALOG.map((entry) => ({
    id: entry.id,
    aliases: entry.aliases,
    defaultKeys: entry.defaultKeys,
  }));
}

/** Apply context-sensitive availability consistently to keyboard and menus. */
export function isHistoryCommandEnabled(id: HistoryCommandId, snapshot: LogSnapshot) {
  const selected = snapshot.rows[snapshot.selected];
  if (
    id === "hunk.history.openSelection" ||
    id === "hunk.history.copyRevision" ||
    id === "hunk.history.startVisualSelection"
  )
    return Boolean(selected);
  if (id === "hunk.history.clearSelection")
    return snapshot.selectionAnchor !== null || snapshot.visualSelectionActive;
  if (
    id === "hunk.history.previousCommit" ||
    id === "hunk.history.extendPrevious" ||
    id === "hunk.history.pageUp" ||
    id === "hunk.history.halfPageUp" ||
    id === "hunk.history.jumpToFirst"
  )
    return snapshot.selected > 0;
  if (
    id === "hunk.history.nextCommit" ||
    id === "hunk.history.extendNext" ||
    id === "hunk.history.pageDown" ||
    id === "hunk.history.halfPageDown" ||
    id === "hunk.history.jumpToLast"
  )
    return !(snapshot.historyDone && snapshot.selected >= snapshot.rows.length - 1);
  if (id === "hunk.history.nextMatch" || id === "hunk.history.previousMatch")
    return Boolean(snapshot.search);
  if (id === "hunk.history.openFirstParent")
    return snapshot.selectionAnchor === null && Boolean(selected?.commit.parentRevisionIds.length);
  if (id === "hunk.history.openParent")
    return (
      snapshot.selectionAnchor === null && (selected?.commit.parentRevisionIds.length ?? 0) > 1
    );
  return true;
}

/** Bind canonical history command identity to live terminal handlers. */
export function buildHistoryCommands({
  getSnapshot,
  handlers,
  resolvedKeys,
}: BuildHistoryCommandsOptions): AppCommand[] {
  return HISTORY_COMMAND_CATALOG.map((entry) => {
    const keys = resolvedKeys?.get(entry.id) ?? entry.defaultKeys;
    return {
      id: entry.id,
      aliases: entry.aliases,
      title: entry.title,
      keys,
      keyLabels: keys.map(formatKeyChord),
      defaultKeys: entry.defaultKeys,
      isEnabled: () => isHistoryCommandEnabled(entry.id as HistoryCommandId, getSnapshot()),
      publicToExtensions: entry.publicToExtensions,
      verticalDirection: entry.verticalDirection,
      closesMenu: entry.closesMenu,
      match: matchesAnyKeyChord(keys),
      run: (key) => handlers[entry.id as HistoryCommandId](key, entry),
    };
  });
}

/** Find the canonical history definition used by menus and tests. */
export function historyCommand(id: HistoryCommandId) {
  return HISTORY_COMMAND_CATALOG.find((entry) => entry.id === id)!;
}

/** Build history help from effective session bindings rather than shipped defaults. */
export function buildHistoryHelpSections(commands: readonly AppCommand[]): readonly HelpSection[] {
  const order: readonly HistoryCommandHelpSection[] = ["Navigation", "Commit", "Application"];
  const byId = new Map(commands.map((command) => [command.id, command]));
  return order.map((title) => ({
    title,
    rows: HISTORY_COMMAND_CATALOG.filter((entry) => entry.helpSection === title)
      .map((entry) => ({ entry, command: byId.get(entry.id) }))
      .filter(({ command }) => command !== undefined && command.keyLabels.length > 0)
      .map(({ entry, command }) => ({
        keys: command!.keyLabels.join(" / "),
        description: entry.title.toLocaleLowerCase(),
      })),
  }));
}
