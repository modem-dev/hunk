/**
 * Projects what the command palette and the help overlay list from the page's command tables.
 *
 * The palette lists every command the page runs: the catalog commands `webCommandTable.ts`
 * implements (host-only and terminal-only ones are never implemented, so they never appear)
 * and the page's own `hunk.web.*` commands, each with its title, category, and the chord the
 * page binds for it. The help overlay groups rows exactly as the terminal's help dialog does
 * (`core/run/helpSections.ts`), keeping only rows whose commands work here, keyed with this
 * page's chords, and adds the page's own chords at the end.
 */
import { formatKeyChord } from "../../core/run/keyChordLabels";
import { HELP_SECTIONS } from "../../core/run/helpSections";
import { webCommandChords, type WebKeymap } from "../commands/keyboard";
import { isWebImplementedCommand, type WebCommand } from "../commands/webCommandTable";
import {
  WEB_LOCAL_COMMANDS,
  webModChordLabel,
  type WebLocalCommandId,
} from "../commands/webLocalCommands";
import { withWebLocalChords } from "../panel/panelCommands";
import { rankFuzzy } from "./fuzzy";

/** One palette row. */
export interface PaletteEntry {
  id: string;
  title: string;
  category: string;
  /** The chord labels that run it here, if any. */
  keys?: string;
}

/** The chord labels the page binds for one catalog command. */
function catalogKeys(keymap: WebKeymap, id: string) {
  const chords = webCommandChords(keymap, id);
  return chords.length > 0 ? chords.map(formatKeyChord).join(" / ") : undefined;
}

/** Every command the palette lists: implemented catalog commands, then the page's own. */
export function buildPaletteEntries(
  commands: readonly WebCommand[],
  keymap: WebKeymap,
  apple?: boolean,
): PaletteEntry[] {
  const catalog = commands.map((command): PaletteEntry => {
    const keys = catalogKeys(keymap, command.entry.id);
    return {
      id: command.entry.id,
      title: command.entry.title,
      category: command.entry.category,
      ...(keys ? { keys } : {}),
    };
  });
  // Plain page chords are labelled from the resolved keymap, so a default the user's binding
  // took over is not named here.
  const pageKeymap = withWebLocalChords(keymap);
  const local = WEB_LOCAL_COMMANDS.map((command): PaletteEntry => {
    const keys =
      "modKey" in command
        ? webModChordLabel(command.modKey, apple)
        : catalogKeys(pageKeymap, command.id);
    return {
      id: command.id,
      title: command.title,
      category: command.category,
      ...(keys ? { keys } : {}),
    };
  });
  return [...catalog, ...local];
}

/**
 * Order palette rows for a query: recently run commands first among equals.
 *
 * With no query, recent commands lead in the order they were last run, then the rest in
 * table order; with a query, the best matches lead and recency breaks ties.
 */
export function rankPaletteEntries(
  entries: readonly PaletteEntry[],
  query: string,
  recents: readonly string[],
): PaletteEntry[] {
  const recency = (id: string) => {
    const index = recents.indexOf(id);
    return index < 0 ? recents.length : index;
  };
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) => recency(left.entry.id) - recency(right.entry.id) || left.index - right.index,
    )
    .map(({ entry }) => entry);
  return rankFuzzy(ordered, query, (entry) => [entry.title, `${entry.category} ${entry.title}`]);
}

/** How many recent commands the palette remembers. */
export const MAX_RECENT_COMMANDS = 8;

/** The recents list after running one command. */
export function rememberRecentCommand(recents: readonly string[], id: string) {
  return [id, ...recents.filter((candidate) => candidate !== id)].slice(0, MAX_RECENT_COMMANDS);
}

/** One rendered help row. */
export interface WebHelpRow {
  keys: string;
  description: string;
}

/** One rendered help section. */
export interface WebHelpSection {
  title: string;
  rows: WebHelpRow[];
}

/**
 * Build the help overlay: the shared sections, keyed with this page's chords.
 *
 * A row lists only commands the page implements and binds; a row left with none, and a
 * terminal-only row, is dropped. `extraRows` are the page's own chords (its dialogs and the
 * composer's save chord), shown last under "Browser".
 */
export function buildWebHelpSections(
  keymap: WebKeymap,
  extraRows: readonly WebHelpRow[] = [],
): WebHelpSection[] {
  const shared = HELP_SECTIONS.map((section) => ({
    title: section.title,
    rows: section.entries.flatMap((entry): WebHelpRow[] => {
      if (entry.terminalOnly) return [];
      if ("keys" in entry) return [{ keys: entry.keys, description: entry.description }];
      const labels = entry.commandIds.flatMap((id) => {
        if (!isWebImplementedCommand(id)) return [];
        const chords = webCommandChords(keymap, id);
        if (chords.length === 0) return [];
        return entry.commandIds.length === 1
          ? chords.map(formatKeyChord)
          : [formatKeyChord(chords[0]!)];
      });
      return labels.length > 0
        ? [{ keys: labels.join(" / "), description: entry.description }]
        : [];
    }),
  }));
  return [...shared, { title: "Browser", rows: [...extraRows] }].filter(
    (section) => section.rows.length > 0,
  );
}

/** The help rows for the page's own chords, plain ones as the resolved keymap binds them. */
export function webLocalHelpRows(keymap: WebKeymap, apple?: boolean): WebHelpRow[] {
  const pageKeymap = withWebLocalChords(keymap);
  const ids: readonly WebLocalCommandId[] = ["hunk.web.commandPalette", "hunk.web.goToFile"];
  const dialogs = ids.flatMap((id) => {
    const command = WEB_LOCAL_COMMANDS.find((candidate) => candidate.id === id)!;
    return "modKey" in command
      ? [
          {
            keys: webModChordLabel(command.modKey, apple),
            description: command.title.toLowerCase(),
          },
        ]
      : [];
  });
  // Page commands with plain chords (the side panel's tools) are listed with them.
  const plain = WEB_LOCAL_COMMANDS.flatMap((command): WebHelpRow[] => {
    const keys = "keys" in command ? catalogKeys(pageKeymap, command.id) : undefined;
    return keys ? [{ keys, description: command.title.toLowerCase() }] : [];
  });
  return [...dialogs, ...plain];
}
