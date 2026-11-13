/**
 * Classifies every catalogued command for the browser page and binds the ones it implements.
 *
 * Identity — id, title, category, default chords, resolution locus — comes from the shared
 * catalog (`core/run/commandCatalog.ts`), exactly as the terminal's table in
 * `ui/lib/appCommands.ts` does; this module only says what the page does with each id. Every
 * catalogued command is classified here in one record keyed by `AppCommandId`, so a command
 * added to the catalog fails to typecheck (and fails `webCommandTable.test.ts`) until the page
 * decides about it:
 *
 * - `implemented` — the page handles it now; `WebCommandHandlers` must supply a handler.
 * - `deferred` — the page will handle it once a named later change lands (notes, filter, the
 *   command palette and help, refresh, or a renderer capability), with the reason.
 * - `unavailable` — it never runs in the browser: `host-only` commands execute where the
 *   review is hosted and are not invocable remotely (audit F4), and `terminal-only` commands
 *   control terminal mechanics the page has a native equivalent for, or none at all.
 *
 * Semantic commands do not restate what they do: the page's navigation handlers lower the
 * catalog entry through `lowerAppCommandToReviewIntent`, like the terminal and the agent.
 */
import {
  APP_COMMAND_CATALOG,
  builtinAppCommand,
  type AppCommandCatalogEntry,
  type AppCommandId,
} from "../../core/run/commandCatalog";

/** Which later change a deferred command waits for. */
export type WebCommandDeferral = "notes" | "filter" | "palette" | "refresh" | "renderer";

/** What the browser page does with one catalogued command. */
export type WebCommandSupport =
  | { kind: "implemented" }
  | { kind: "deferred"; until: WebCommandDeferral; reason: string }
  | { kind: "unavailable"; scope: "host-only" | "terminal-only"; reason: string };

const IMPLEMENTED = { kind: "implemented" } as const;

/** Deferred until reviewer and agent notes reach the page. */
function notes(reason: string) {
  return { kind: "deferred", until: "notes", reason } as const;
}

/** Runs where the review is hosted; a remote page may not start it (audit F4). */
function hostOnly(reason: string) {
  return { kind: "unavailable", scope: "host-only", reason } as const;
}

/** Controls a terminal mechanism the page does not have. */
function terminalOnly(reason: string) {
  return { kind: "unavailable", scope: "terminal-only", reason } as const;
}

/** The page's decision for every catalogued command, in no particular order. */
export const WEB_COMMAND_SUPPORT = {
  "hunk.review.jumpToBottom": IMPLEMENTED,
  "hunk.review.jumpToTop": IMPLEMENTED,
  "hunk.app.quit": hostOnly("Quitting ends the hosted session; closing the tab is the page's own."),
  "hunk.app.toggleHelp": {
    kind: "deferred",
    until: "palette",
    reason: "The help overlay arrives with the command palette, which renders from this table.",
  },
  "hunk.app.openAgentSkill": hostOnly("Shows the agent skill from the host's installation."),
  "hunk.app.openFeedback": hostOnly("The feedback form sends from the host."),
  "hunk.app.toggleFocusArea": terminalOnly(
    "Tab moves focus natively in the browser: toolbar, sidebar, then the review stream.",
  ),
  "hunk.review.focusFilter": {
    kind: "deferred",
    until: "filter",
    reason: "The page has no file filter yet; the filter is shared review state.",
  },
  "hunk.review.startVisualSelection": terminalOnly(
    "The browser selects text natively with the mouse or Shift and the arrow keys.",
  ),
  "hunk.review.copySelection": terminalOnly("The browser copies a native selection itself."),
  "hunk.review.clearSelection": terminalOnly("A native selection clears by clicking elsewhere."),
  "hunk.review.startNote": notes("Starting a note needs the composer and the notes route."),
  "hunk.review.editActiveNote": notes("Editing needs the notes the page cannot show yet."),
  "hunk.review.replyToActiveNote": notes("Replying needs the notes the page cannot show yet."),
  "hunk.review.deleteActiveNote": notes("Deleting needs the notes the page cannot show yet."),
  "hunk.review.previousNote": notes("Note navigation walks rendered note cards."),
  "hunk.review.nextNote": notes("Note navigation walks rendered note cards."),
  "hunk.review.saveNote": notes(
    "Saving needs the composer; its Ctrl+S chord is also the browser's.",
  ),
  "hunk.review.pageDown": IMPLEMENTED,
  "hunk.review.pageUp": IMPLEMENTED,
  "hunk.review.halfPageDown": IMPLEMENTED,
  "hunk.review.halfPageUp": IMPLEMENTED,
  "hunk.review.stepDown": IMPLEMENTED,
  "hunk.review.stepUp": IMPLEMENTED,
  "hunk.review.scrollCodeLeft": IMPLEMENTED,
  "hunk.review.scrollCodeRight": IMPLEMENTED,
  "hunk.review.alignCurrentLineTop": terminalOnly(
    "Aligns the terminal's line cursor; the page has no line cursor.",
  ),
  "hunk.review.alignCurrentLineCenter": terminalOnly(
    "Aligns the terminal's line cursor; the page has no line cursor.",
  ),
  "hunk.review.alignCurrentLineBottom": terminalOnly(
    "Aligns the terminal's line cursor; the page has no line cursor.",
  ),
  "hunk.view.cursorLineRow": terminalOnly("Styles the terminal's line cursor."),
  "hunk.view.cursorLineNumber": terminalOnly("Styles the terminal's line cursor."),
  "hunk.view.cursorLineOff": terminalOnly("Styles the terminal's line cursor."),
  "hunk.view.layoutSplit": IMPLEMENTED,
  "hunk.view.layoutUnified": IMPLEMENTED,
  "hunk.view.layoutAuto": IMPLEMENTED,
  "hunk.view.applyFilePresentationToAllMatching": terminalOnly(
    "File presentations are extension file views, which render only in the terminal.",
  ),
  "hunk.view.toggleFilesPane": IMPLEMENTED,
  "hunk.app.refresh": {
    kind: "deferred",
    until: "refresh",
    reason: "The refresh route exists; the page's refresh control is a later change.",
  },
  "hunk.view.openThemeSelector": IMPLEMENTED,
  "hunk.view.toggleAgentNotes": notes("Note visibility is shared state the page cannot set yet."),
  "hunk.view.toggleLineNumbers": IMPLEMENTED,
  "hunk.view.toggleLineWrap": IMPLEMENTED,
  "hunk.view.toggleMenuBar": terminalOnly("The page's toolbar is always shown."),
  "hunk.view.toggleHunkHeaders": {
    kind: "deferred",
    until: "renderer",
    reason:
      "Pierre draws hunk header rows only in its built-in separator modes, which cannot " +
      "coexist with the page's own gap separators.",
  },
  "hunk.view.toggleCopyDecorations": terminalOnly(
    "Decides what a terminal copy includes; browser copies are native.",
  ),
  "hunk.review.toggleHunkGap": IMPLEMENTED,
  "hunk.review.editSelectedFile": hostOnly("Opens $EDITOR on the host."),
  "hunk.review.previousHunk": IMPLEMENTED,
  "hunk.review.nextHunk": IMPLEMENTED,
  "hunk.review.previousFile": IMPLEMENTED,
  "hunk.review.nextFile": IMPLEMENTED,
  "hunk.review.previousAnnotatedHunk": notes("Which hunks carry notes arrives with notes."),
  "hunk.review.nextAnnotatedHunk": notes("Which hunks carry notes arrives with notes."),
  "hunk.review.previousAnnotatedFile": notes("Which files carry notes arrives with notes."),
  "hunk.review.nextAnnotatedFile": notes("Which files carry notes arrives with notes."),
} as const satisfies Record<AppCommandId, WebCommandSupport>;

/** Every command id the page implements now. */
export type WebImplementedCommandId = {
  [Id in AppCommandId]: (typeof WEB_COMMAND_SUPPORT)[Id] extends { kind: "implemented" }
    ? Id
    : never;
}[AppCommandId];

/** What one handler is told about the invocation. */
export interface WebCommandInvocation {
  entry: AppCommandCatalogEntry;
  /** Host-normalized positive repeat count; always 1 until the page accepts count prefixes. */
  count: number;
  /** Whether the chord that ran it carried Shift (`shift+left` scrolls code further). */
  shift: boolean;
}

/** What the page does for each command it implements. */
export type WebCommandHandlers = Record<
  WebImplementedCommandId,
  (invocation: WebCommandInvocation) => void
>;

/** One command the page can run: its shared identity and the page's handler. */
export interface WebCommand {
  entry: AppCommandCatalogEntry;
  run: (invocation: Omit<WebCommandInvocation, "entry">) => void;
}

/** Report whether the page implements one command id. */
export function isWebImplementedCommand(id: string): id is WebImplementedCommandId {
  return (WEB_COMMAND_SUPPORT as Record<string, WebCommandSupport>)[id]?.kind === "implemented";
}

/** The commands the page runs, in catalog order (which breaks chord ties, as in the terminal). */
export function buildWebCommands(handlers: WebCommandHandlers): WebCommand[] {
  return APP_COMMAND_CATALOG.flatMap((entry): WebCommand[] => {
    if (!isWebImplementedCommand(entry.id)) return [];
    const handler = handlers[entry.id];
    return [{ entry, run: (invocation) => handler({ entry, ...invocation }) }];
  });
}

/** The catalog entry for one implemented command, for labels beside its controls. */
export function webCommandEntry(id: WebImplementedCommandId) {
  return builtinAppCommand(id);
}
