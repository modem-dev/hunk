/**
 * Declares the controls help: its sections, their order, and each row's wording.
 *
 * Rows are hand-written for someone learning Hunk, but name the commands they document
 * rather than their keys, so each surface renders the key column from its own live chords:
 * the terminal's help dialog (`ui/lib/helpContent.ts`) and the browser page's help overlay
 * (`web/palette/helpProjection.ts`). A row with literal `keys` documents behavior that is not
 * a command (the mouse wheel, F10).
 */
/** One documented row, as declared. */
export type HelpEntrySpec = {
  description: string;
  /** Behavior only the terminal has (its menu bar); other surfaces leave the row out. */
  terminalOnly?: true;
} & ({ keys: string } | { commandIds: readonly string[] });

export interface HelpSectionSpec {
  title: string;
  entries: readonly HelpEntrySpec[];
}

export const HELP_SECTIONS: readonly HelpSectionSpec[] = [
  {
    title: "Navigation",
    entries: [
      {
        commandIds: ["hunk.review.stepUp", "hunk.review.stepDown"],
        description: "move through lines and notes",
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
        description: "annotated hunk / exact note",
      },
      { commandIds: ["hunk.search.find"], description: "search diff content" },
      {
        commandIds: ["hunk.search.next", "hunk.search.previous"],
        description: "next / previous search match",
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
        commandIds: ["hunk.view.layoutUnified", "hunk.view.layoutSplit", "hunk.view.layoutAuto"],
        description: "unified / split / auto",
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
        commandIds: [
          "hunk.review.editActiveNote",
          "hunk.review.replyToActiveNote",
          "hunk.review.deleteActiveNote",
        ],
        description: "edit / reply / delete active note",
      },
      { commandIds: ["hunk.app.toggleFocusArea"], description: "toggle files/filter focus" },
      { keys: "F10", description: "open menus", terminalOnly: true },
      { commandIds: ["hunk.app.refresh"], description: "reload the review" },
      { commandIds: ["hunk.app.quit"], description: "quit" },
    ],
  },
];
