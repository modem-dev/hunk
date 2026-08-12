/**
 * Hunk's command vocabulary, as data every client can render.
 *
 * A command fuses three separable things: identity (id, title, chords), binding (matching
 * one client's key events), and effect (doing the thing). Only identity is shared, so only
 * identity lives here — a terminal `KeyEvent` matcher and a closure over live app state
 * are not portable, and a browser palette that restated this list would immediately drift
 * from the terminal's menus and help (`docs/browser-review-seam-audit.md`, F1–F3).
 *
 * Each entry also declares where it resolves:
 *
 * - `semantic` — it changes the review itself, so it lowers to a `ReviewIntent` and every
 *   attached surface sees the result. Its effect is declared as data rather than as a
 *   function, which is what lets the same declaration drive the terminal's handler, an
 *   agent command, and later a wire action.
 * - `client-local` — deliberately per-client view state (scrolling, layout, theme, help).
 *   Each client implements its own handler; sharing identity is what keeps help screens
 *   and palettes agreeing about what the command is called and what it is bound to.
 * - `host-only` — it runs where the review is hosted (quitting, reloading the source,
 *   opening `$EDITOR`). Not invocable from a remote client without an explicit allowlist,
 *   which is a scope boundary rather than a missing feature (audit F4).
 *
 * This module is deliberately renderer-neutral and dependency-light: no OpenTUI, no React,
 * no Node builtins, chords as plain strings. It is not part of `src/core/review` because
 * it describes UI vocabulary rather than review semantics, and that module stays purely
 * about what a review *is*.
 */
import type { ReviewIntent } from "./review/intents";
import type { ReviewSelectionScope } from "./review/navigation";
import type { ReviewState } from "./review/state";

/** Where one command's effect resolves, and therefore who may invoke it. */
export type AppCommandLocus = "semantic" | "client-local" | "host-only";

/** The id group a command lives under, and the menu-level grouping users read. */
export type AppCommandCategory = "app" | "review" | "view";

/**
 * What a semantic command does to the review, declared rather than closed over.
 *
 * Data, not a callback: the terminal reads the same declaration to wire its handler that
 * the lowering below reads to build an intent, so "which way does `]` move" has one
 * answer instead of one per surface.
 */
export type AppCommandReviewEffect =
  | { kind: "selection/move"; scope: ReviewSelectionScope; direction: 1 | -1 }
  | { kind: "notes/toggle-visibility" };

export interface AppCommandCatalogEntry {
  /** Stable identifier, `hunk.<category>.<name>` for every built-in. */
  id: string;
  title: string;
  category: AppCommandCategory;
  /** Chords the command ships with, before the user's `[keybindings]` are folded in. */
  defaultKeys: readonly string[];
  locus: AppCommandLocus;
  /** The review effect a semantic command lowers to, where one is already modelled. */
  review?: AppCommandReviewEffect;
  /** True when extension command controls may invoke this command by id. */
  publicToExtensions: boolean;
  /** Close an open dropdown menu after running. */
  closesMenu?: boolean;
}

/**
 * Every built-in command.
 *
 * Order is the tiebreaker when several commands could match one key, so entries keep the
 * relative order the terminal's original key cascade had (uppercase forms before
 * lowercase ones). A few ship with no chords at all: declaring them keeps them bindable
 * from `[keybindings]` and dispatchable by id whether or not a menu presents them.
 */
const BUILTIN_COMMANDS = [
  {
    id: "hunk.review.jumpToBottom",
    title: "Jump to end",
    category: "review",
    defaultKeys: ["G", "end"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.jumpToTop",
    title: "Jump to start",
    category: "review",
    defaultKeys: ["g", "home"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.app.quit",
    title: "Quit",
    category: "app",
    defaultKeys: ["q"],
    locus: "host-only",
    publicToExtensions: true,
  },
  {
    id: "hunk.app.toggleHelp",
    title: "Toggle help",
    category: "app",
    defaultKeys: ["?"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.app.openAgentSkill",
    title: "Show agent skill",
    category: "app",
    defaultKeys: [],
    locus: "host-only",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.app.toggleFocusArea",
    title: "Switch focus between files and filter",
    category: "app",
    defaultKeys: ["tab"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.focusFilter",
    title: "Focus the file filter",
    category: "review",
    defaultKeys: ["/"],
    // Moving keyboard focus is this client's business; the filter value it edits is
    // shared review state, changed through `filter/set` rather than by this command.
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.startNote",
    title: "Add a review note",
    category: "review",
    defaultKeys: ["c"],
    locus: "semantic",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.pageDown",
    title: "Scroll down one page",
    category: "review",
    defaultKeys: ["pagedown", "space", "f"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.pageUp",
    title: "Scroll up one page",
    category: "review",
    defaultKeys: ["pageup", "b", "shift+space"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.halfPageDown",
    title: "Scroll down half a page",
    category: "review",
    defaultKeys: ["d"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.halfPageUp",
    title: "Scroll up half a page",
    category: "review",
    defaultKeys: ["u"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.stepDown",
    title: "Scroll down one row",
    category: "review",
    defaultKeys: ["down", "j"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.stepUp",
    title: "Scroll up one row",
    category: "review",
    defaultKeys: ["up", "k"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.scrollCodeLeft",
    title: "Scroll code left",
    category: "review",
    // Both chords run the same command; the shifted one scrolls further, so the handler
    // reads the event rather than splitting this into two commands.
    defaultKeys: ["left", "shift+left"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.scrollCodeRight",
    title: "Scroll code right",
    category: "review",
    defaultKeys: ["right", "shift+right"],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.alignCurrentLineTop",
    title: "Align current line to top",
    category: "review",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.alignCurrentLineCenter",
    title: "Align current line to center",
    category: "review",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.review.alignCurrentLineBottom",
    title: "Align current line to bottom",
    category: "review",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: true,
  },
  {
    id: "hunk.view.cursorLineRow",
    title: "Highlight the current row",
    category: "view",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.cursorLineNumber",
    title: "Mark the current line number",
    category: "view",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.cursorLineOff",
    title: "Hide the current-line marker",
    category: "view",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.layoutSplit",
    title: "Split layout",
    category: "view",
    defaultKeys: ["1"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.layoutStack",
    title: "Stack layout",
    category: "view",
    defaultKeys: ["2"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.layoutAuto",
    title: "Auto layout",
    category: "view",
    defaultKeys: ["0"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.applyFilePresentationToAllMatching",
    title: "Apply the current file presentation to all matching files",
    category: "view",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.toggleSidebar",
    title: "Toggle sidebar",
    category: "view",
    defaultKeys: ["s"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.app.refresh",
    title: "Refresh the review",
    category: "app",
    defaultKeys: ["r"],
    locus: "host-only",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.openThemeSelector",
    title: "Choose theme",
    category: "view",
    defaultKeys: ["t"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.toggleAgentNotes",
    title: "Toggle agent notes",
    category: "view",
    defaultKeys: ["a"],
    locus: "semantic",
    review: { kind: "notes/toggle-visibility" },
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.toggleLineNumbers",
    title: "Toggle line numbers",
    category: "view",
    defaultKeys: ["l"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.toggleLineWrap",
    title: "Toggle line wrapping",
    category: "view",
    defaultKeys: ["w"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.toggleMenuBar",
    title: "Toggle menu bar",
    category: "view",
    defaultKeys: ["M"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.toggleHunkHeaders",
    title: "Toggle hunk headers",
    category: "view",
    defaultKeys: ["m"],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.view.toggleCopyDecorations",
    title: "Toggle copy decorations",
    category: "view",
    defaultKeys: [],
    locus: "client-local",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.toggleHunkGap",
    title: "Expand or collapse context for the selected hunk",
    category: "review",
    defaultKeys: ["z"],
    locus: "semantic",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.editSelectedFile",
    title: "Open the selected file in your editor",
    category: "review",
    defaultKeys: ["e"],
    locus: "host-only",
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.previousHunk",
    title: "Previous hunk",
    category: "review",
    defaultKeys: ["["],
    locus: "semantic",
    review: { kind: "selection/move", scope: "hunk", direction: -1 },
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.nextHunk",
    title: "Next hunk",
    category: "review",
    defaultKeys: ["]"],
    locus: "semantic",
    review: { kind: "selection/move", scope: "hunk", direction: 1 },
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.previousFile",
    title: "Previous file",
    category: "review",
    defaultKeys: [","],
    locus: "semantic",
    review: { kind: "selection/move", scope: "file", direction: -1 },
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.nextFile",
    title: "Next file",
    category: "review",
    defaultKeys: ["."],
    locus: "semantic",
    review: { kind: "selection/move", scope: "file", direction: 1 },
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.previousAnnotatedHunk",
    title: "Previous annotated hunk",
    category: "review",
    defaultKeys: ["{"],
    locus: "semantic",
    review: { kind: "selection/move", scope: "annotated-hunk", direction: -1 },
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.nextAnnotatedHunk",
    title: "Next annotated hunk",
    category: "review",
    defaultKeys: ["}"],
    locus: "semantic",
    review: { kind: "selection/move", scope: "annotated-hunk", direction: 1 },
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.previousAnnotatedFile",
    title: "Previous annotated file",
    category: "review",
    defaultKeys: [],
    locus: "semantic",
    review: { kind: "selection/move", scope: "annotated-file", direction: -1 },
    publicToExtensions: true,
    closesMenu: true,
  },
  {
    id: "hunk.review.nextAnnotatedFile",
    title: "Next annotated file",
    category: "review",
    defaultKeys: [],
    locus: "semantic",
    review: { kind: "selection/move", scope: "annotated-file", direction: 1 },
    publicToExtensions: true,
    closesMenu: true,
  },
] as const satisfies readonly AppCommandCatalogEntry[];

/**
 * Every built-in command id, as a type — a client cannot name one that does not exist.
 *
 * Derived from the literal declaration above, which is why that one stays `as const` while
 * the exported catalog is widened to the entry shape consumers read.
 */
export type AppCommandId = (typeof BUILTIN_COMMANDS)[number]["id"];

export const APP_COMMAND_CATALOG: readonly AppCommandCatalogEntry[] = BUILTIN_COMMANDS;

/**
 * Semantic commands whose review effect is not modelled as an intent yet.
 *
 * Named rather than implied: both change the review for every attached surface and belong
 * at the producer, but neither has an intent to lower to today — starting a note needs a
 * caller-owned draft identity and a resolved line target, and gap expansion is the
 * `expansion/toggle` intent staged for the producer-runtime phase. Until those land, the
 * terminal keeps resolving them locally, and this list is what keeps that a decision
 * instead of an oversight.
 */
export const SEMANTIC_COMMANDS_WITHOUT_REVIEW_EFFECT: readonly AppCommandId[] = [
  "hunk.review.startNote",
  "hunk.review.toggleHunkGap",
];

/** Look one command up by id. */
export function appCommandCatalogEntry(id: string): AppCommandCatalogEntry | undefined {
  return APP_COMMAND_CATALOG.find((entry) => entry.id === id);
}

/** The facts a command needs to become one concrete review intent. */
export interface AppCommandLoweringContext {
  /** Host-normalized positive repeat count. */
  count: number;
  /** Current review state, for commands whose effect depends on what it already says. */
  state: Pick<ReviewState, "showAgentNotes">;
}

/**
 * Lower one command into the review intent it asks for.
 *
 * The single constructor every surface goes through: a keyboard chord, a browser palette
 * entry, and an agent command that name the same id produce the same intent. Undefined
 * means the command has no declared review effect — it is client-local, host-only, or one
 * of the semantic commands still listed above.
 */
export function lowerAppCommandToReviewIntent(
  entry: AppCommandCatalogEntry,
  { count, state }: AppCommandLoweringContext,
): ReviewIntent | undefined {
  switch (entry.review?.kind) {
    case "selection/move":
      return {
        type: "selection/move",
        scope: entry.review.scope,
        delta: entry.review.direction * count,
      };
    case "notes/toggle-visibility":
      return { type: "notes/set-visibility", visible: !state.showAgentNotes };
    case undefined:
      return undefined;
  }
}
