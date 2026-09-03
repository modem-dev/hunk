import { isCommandEnabled, type AppCommand } from "./appCommands";

/**
 * The curated content of the controls help dialog.
 *
 * The rows are hand-written — grouped, ordered, and worded for someone learning
 * the app — but the keys in them are not: each row names the commands it
 * documents and the key column is rendered from whatever chords those commands
 * currently answer to. Remap a command and help says so; unbind it and its row
 * disappears rather than advertising a key that does nothing.
 *
 * A few rows document behavior that is not a command at all (the mouse wheel,
 * F10 opening the menus, which belong to the widgets that own them). Those
 * carry literal key text, and are the only place a key is written by hand.
 */

/** One documented row, as declared. */
type HelpEntrySpec = {
  description: string;
} & ({ keys: string } | { commandIds: readonly string[] });

interface HelpSectionSpec {
  title: string;
  entries: readonly HelpEntrySpec[];
}

/** One rendered row: the key column text and what it does. */
export interface HelpRow {
  keys: string;
  description: string;
}

/** One rendered section of the dialog. */
export interface HelpSection {
  title: string;
  rows: HelpRow[];
}

const HELP_SECTIONS: readonly HelpSectionSpec[] = [
  {
    title: "Navigation",
    entries: [
      {
        commandIds: ["hunk.review.stepUp", "hunk.review.stepDown"],
        description: "move line-by-line",
      },
      { commandIds: ["hunk.review.pageDown"], description: "page down" },
      { commandIds: ["hunk.review.pageUp"], description: "page up" },
      {
        commandIds: ["hunk.review.halfPageDown", "hunk.review.halfPageUp"],
        description: "half page down / up",
      },
      {
        commandIds: ["hunk.review.previousHunk", "hunk.review.nextHunk"],
        description: "previous / next hunk",
      },
      {
        commandIds: ["hunk.review.previousFile", "hunk.review.nextFile"],
        description: "previous / next file",
      },
      {
        commandIds: ["hunk.review.previousAnnotatedHunk", "hunk.review.nextAnnotatedHunk"],
        description: "previous / next comment",
      },
      {
        commandIds: ["hunk.review.scrollCodeLeft", "hunk.review.scrollCodeRight"],
        description: "scroll code sideways (Shift = faster)",
      },
      { commandIds: ["hunk.review.jumpToTop"], description: "jump to start" },
      { commandIds: ["hunk.review.jumpToBottom"], description: "jump to end" },
    ],
  },
  {
    title: "Mouse",
    entries: [
      { keys: "Wheel", description: "scroll vertically" },
      { keys: "Shift+Wheel", description: "scroll code horizontally" },
    ],
  },
  {
    title: "View",
    entries: [
      {
        commandIds: ["hunk.view.layoutSplit", "hunk.view.layoutStack", "hunk.view.layoutAuto"],
        description: "split / stack / auto",
      },
      {
        commandIds: ["hunk.view.toggleFilesPane", "hunk.view.openThemeSelector"],
        description: "sidebar / theme selector",
      },
      { commandIds: ["hunk.view.toggleAgentNotes"], description: "toggle AI notes" },
      { commandIds: ["hunk.review.toggleHunkGap"], description: "toggle unchanged context" },
      {
        commandIds: [
          "hunk.view.toggleLineNumbers",
          "hunk.view.toggleLineWrap",
          "hunk.view.toggleHunkHeaders",
          "hunk.view.toggleMenuBar",
        ],
        description: "lines / wrap / metadata / menu",
      },
      { commandIds: ["hunk.review.editSelectedFile"], description: "open file in $EDITOR" },
    ],
  },
  {
    title: "Review",
    entries: [
      { commandIds: ["hunk.review.focusFilter"], description: "focus file filter" },
      { commandIds: ["hunk.review.startNote"], description: "create review note" },
      { commandIds: ["hunk.review.saveNote"], description: "save draft note" },
      {
        commandIds: ["hunk.review.editActiveNote", "hunk.review.replyToActiveNote"],
        description: "edit / reply to active note",
      },
      { commandIds: ["hunk.app.toggleFocusArea"], description: "toggle files/filter focus" },
      { keys: "F10", description: "open menus" },
      { commandIds: ["hunk.app.refresh"], description: "reload the review" },
      { commandIds: ["hunk.app.quit"], description: "quit" },
    ],
  },
];

/**
 * Every command id the help dialog documents.
 *
 * Exported so the command-parity check can assert help names only catalogued commands: a
 * row pointing at an id nobody registered would silently vanish instead of failing.
 */
export const HELP_COMMAND_IDS: readonly string[] = HELP_SECTIONS.flatMap((section) =>
  section.entries.flatMap((entry) => ("commandIds" in entry ? [...entry.commandIds] : [])),
);

/**
 * Render one entry's key column, or nothing when it documents no live key.
 *
 * A row about one command lists every chord it answers to, since there is room
 * for the alternates; a row covering several commands shows each one's primary
 * chord instead, so the column stays readable. Either way a command that is
 * disabled or unbound contributes nothing, and a row left with no keys at all
 * is dropped by the caller.
 */
function helpEntryKeys(commands: readonly AppCommand[], spec: HelpEntrySpec): string | undefined {
  if ("keys" in spec) {
    return spec.keys;
  }

  const labels = spec.commandIds.flatMap((id) => {
    const command = commands.find((candidate) => candidate.id === id);
    if (!command || !isCommandEnabled(command)) {
      return [];
    }

    return spec.commandIds.length === 1 ? [...command.keyLabels] : command.keyLabels.slice(0, 1);
  });

  return labels.length > 0 ? labels.join(" / ") : undefined;
}

/** Build the help dialog's sections against the session's live command table. */
export function buildHelpSections(commands: readonly AppCommand[]): HelpSection[] {
  return HELP_SECTIONS.map((section) => ({
    title: section.title,
    rows: section.entries.flatMap((spec) => {
      const keys = helpEntryKeys(commands, spec);
      return keys === undefined ? [] : [{ keys, description: spec.description }];
    }),
  })).filter((section) => section.rows.length > 0);
}
