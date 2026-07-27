import type { KeyEvent } from "@opentui/core";
import type { LayoutMode } from "../../core/types";
import {
  isCreateReviewNoteKey,
  isHalfPageDownKey,
  isHalfPageUpKey,
  isPageDownKey,
  isPageUpKey,
  isShiftSpacePageUpKey,
  isStepDownKey,
  isStepUpKey,
} from "./keyboard";

type ScrollUnit = "step" | "viewport" | "content" | "half";

/** Top-level input scopes a command can be active in. */
export type AppCommandScope = "review" | "pager";

const FAST_CODE_HORIZONTAL_SCROLL_COLUMNS = 8;

/**
 * One named keyboard command.
 *
 * Every app-level shortcut is one of these — built-in and
 * extension-contributed alike — dispatched by a single loop in
 * `useAppKeyboardShortcuts`. Modal navigation (arrow keys inside a dialog,
 * escape closing a prompt) is deliberately not a command: those keys are the
 * structure of the widget that owns them, not shortcuts a user rebinds or an
 * extension extends.
 */
export interface AppCommand {
  /** Stable identifier; extension commands are namespaced `<extensionId>.<id>`. */
  id: string;
  title: string;
  scopes: readonly AppCommandScope[];
  /** Human-readable key labels for menus, help, and conflict messages. */
  keyLabels: readonly string[];
  /** Report whether the command may run right now; skipped when false. */
  isEnabled?: () => boolean;
  match: (key: KeyEvent) => boolean;
  run: (key: KeyEvent) => void;
  /** Close an open dropdown menu after running. */
  closesMenu?: boolean;
}

/** Detect an unmodified lowercase g keypress. */
function isLowercaseGKey(key: KeyEvent) {
  return (
    (key.name === "g" || key.sequence === "g") &&
    !key.shift &&
    !key.option &&
    !key.ctrl &&
    !key.meta
  );
}

/** Detect an unmodified uppercase G keypress. */
function isUppercaseGKey(key: KeyEvent) {
  return (
    (key.sequence === "G" && !key.option && !key.ctrl && !key.meta) ||
    (key.name === "g" && key.shift && !key.option && !key.ctrl && !key.meta)
  );
}

/** Detect Shift-M without stealing the lowercase hunk metadata toggle. */
function isUppercaseMKey(key: KeyEvent) {
  return (
    (key.sequence === "M" && !key.option && !key.ctrl && !key.meta) ||
    (key.name === "m" && key.shift && !key.option && !key.ctrl && !key.meta)
  );
}

/** The callbacks the built-in command set drives; App supplies its own handlers. */
export interface BuildAppCommandsOptions {
  canRefreshCurrentInput: boolean;
  focusFilter: () => void;
  moveToAnnotatedHunk: (delta: number) => void;
  moveToFile: (delta: number) => void;
  moveToHunk: (delta: number) => void;
  openThemeSelector: () => void;
  requestQuit: () => void;
  scrollCodeHorizontally: (delta: number) => void;
  scrollDiff: (delta: number, unit: ScrollUnit) => void;
  selectLayoutMode: (mode: LayoutMode) => void;
  startUserNote: () => void;
  toggleAgentNotes: () => void;
  toggleFocusArea: () => void;
  toggleGapForSelectedHunk: () => void;
  toggleHelp: () => void;
  toggleHunkHeaders: () => void;
  toggleLineNumbers: () => void;
  toggleLineWrap: () => void;
  toggleMenuBar: () => void;
  toggleSidebar: () => void;
  triggerEditSelectedFile: () => void;
  triggerRefreshCurrentInput: () => void;
}

const REVIEW: readonly AppCommandScope[] = ["review"];
const REVIEW_AND_PAGER: readonly AppCommandScope[] = ["review", "pager"];

/** Match one unmodified single character by key name or reported sequence. */
function plainKey(name: string) {
  return (key: KeyEvent) =>
    (key.name === name || key.sequence === name) && !key.ctrl && !key.meta && !key.option;
}

/**
 * Build Hunk's built-in command table.
 *
 * Order is the tiebreaker when several commands could match one key, exactly
 * as the old cascade of if-statements was, so entries keep the old cascade's
 * relative order where it mattered (uppercase before lowercase forms).
 */
export function buildAppCommands(options: BuildAppCommandsOptions): AppCommand[] {
  return [
    {
      id: "review.jumpToBottom",
      title: "Jump to end",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["G", "End"],
      match: (key) => isUppercaseGKey(key) || key.name === "end",
      run: () => options.scrollDiff(1, "content"),
    },
    {
      id: "review.jumpToTop",
      title: "Jump to start",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["g", "Home"],
      match: (key) => isLowercaseGKey(key) || key.name === "home",
      run: () => options.scrollDiff(-1, "content"),
    },
    {
      id: "app.quit",
      title: "Quit",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["q"],
      match: (key) => key.name === "q",
      run: () => options.requestQuit(),
    },
    {
      id: "app.toggleHelp",
      title: "Toggle help",
      scopes: REVIEW,
      keyLabels: ["?"],
      match: (key) => key.name === "?" || key.sequence === "?",
      run: () => options.toggleHelp(),
      closesMenu: true,
    },
    {
      id: "app.toggleFocusArea",
      title: "Switch focus between files and filter",
      scopes: REVIEW,
      keyLabels: ["Tab"],
      match: (key) => key.name === "tab",
      run: () => options.toggleFocusArea(),
    },
    {
      id: "review.focusFilter",
      title: "Focus the file filter",
      scopes: REVIEW,
      keyLabels: ["/"],
      match: (key) => key.name === "/",
      run: () => options.focusFilter(),
    },
    {
      id: "review.startNote",
      title: "Add a review note",
      scopes: REVIEW,
      keyLabels: ["c"],
      match: isCreateReviewNoteKey,
      run: () => options.startUserNote(),
      closesMenu: true,
    },
    {
      id: "review.pageDown",
      title: "Scroll down one page",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["PageDown", "Space", "f"],
      match: isPageDownKey,
      run: () => options.scrollDiff(1, "viewport"),
    },
    {
      id: "review.pageUp",
      title: "Scroll up one page",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["PageUp", "b", "Shift+Space"],
      match: (key) => isPageUpKey(key) || isShiftSpacePageUpKey(key),
      run: () => options.scrollDiff(-1, "viewport"),
    },
    {
      id: "review.halfPageDown",
      title: "Scroll down half a page",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["d"],
      match: isHalfPageDownKey,
      run: () => options.scrollDiff(1, "half"),
    },
    {
      id: "review.halfPageUp",
      title: "Scroll up half a page",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["u"],
      match: isHalfPageUpKey,
      run: () => options.scrollDiff(-1, "half"),
    },
    {
      id: "review.stepDown",
      title: "Scroll down one row",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["Down", "j"],
      match: isStepDownKey,
      run: () => options.scrollDiff(1, "step"),
    },
    {
      id: "review.stepUp",
      title: "Scroll up one row",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["Up", "k"],
      match: isStepUpKey,
      run: () => options.scrollDiff(-1, "step"),
    },
    {
      id: "review.scrollCodeLeft",
      title: "Scroll code left",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["Left", "Shift+Left"],
      match: (key) => key.name === "left",
      run: (key) =>
        options.scrollCodeHorizontally(key.shift ? -FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : -1),
    },
    {
      id: "review.scrollCodeRight",
      title: "Scroll code right",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["Right", "Shift+Right"],
      match: (key) => key.name === "right",
      run: (key) =>
        options.scrollCodeHorizontally(key.shift ? FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : 1),
    },
    {
      id: "view.layoutSplit",
      title: "Split layout",
      scopes: REVIEW,
      keyLabels: ["1"],
      match: (key) => key.name === "1",
      run: () => options.selectLayoutMode("split"),
      closesMenu: true,
    },
    {
      id: "view.layoutStack",
      title: "Stack layout",
      scopes: REVIEW,
      keyLabels: ["2"],
      match: (key) => key.name === "2",
      run: () => options.selectLayoutMode("stack"),
      closesMenu: true,
    },
    {
      id: "view.layoutAuto",
      title: "Auto layout",
      scopes: REVIEW,
      keyLabels: ["0"],
      match: (key) => key.name === "0",
      run: () => options.selectLayoutMode("auto"),
      closesMenu: true,
    },
    {
      id: "view.toggleSidebar",
      title: "Toggle sidebar",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["s"],
      match: (key) => key.name === "s" || key.sequence === "s",
      run: () => options.toggleSidebar(),
      closesMenu: true,
    },
    {
      id: "app.refresh",
      title: "Refresh the review",
      scopes: REVIEW,
      keyLabels: ["r"],
      isEnabled: () => options.canRefreshCurrentInput,
      match: (key) => key.name === "r" || key.sequence === "r",
      run: () => options.triggerRefreshCurrentInput(),
      closesMenu: true,
    },
    {
      id: "view.openThemeSelector",
      title: "Choose theme",
      scopes: REVIEW,
      keyLabels: ["t"],
      match: (key) => key.name === "t",
      run: () => options.openThemeSelector(),
      closesMenu: true,
    },
    {
      id: "view.toggleAgentNotes",
      title: "Toggle agent notes",
      scopes: REVIEW,
      keyLabels: ["a"],
      match: (key) => key.name === "a",
      run: () => options.toggleAgentNotes(),
      closesMenu: true,
    },
    {
      id: "view.toggleLineNumbers",
      title: "Toggle line numbers",
      scopes: REVIEW,
      keyLabels: ["l"],
      match: (key) => key.name === "l" || key.sequence === "l",
      run: () => options.toggleLineNumbers(),
      closesMenu: true,
    },
    {
      id: "view.toggleLineWrap",
      title: "Toggle line wrapping",
      scopes: REVIEW_AND_PAGER,
      keyLabels: ["w"],
      match: (key) => key.name === "w" || key.sequence === "w",
      run: () => options.toggleLineWrap(),
      closesMenu: true,
    },
    {
      id: "view.toggleMenuBar",
      title: "Toggle menu bar",
      scopes: REVIEW,
      keyLabels: ["M"],
      match: isUppercaseMKey,
      run: () => options.toggleMenuBar(),
      closesMenu: true,
    },
    {
      id: "view.toggleHunkHeaders",
      title: "Toggle hunk headers",
      scopes: REVIEW,
      keyLabels: ["m"],
      match: (key) => key.name === "m" || key.sequence === "m",
      run: () => options.toggleHunkHeaders(),
      closesMenu: true,
    },
    {
      id: "review.toggleHunkGap",
      title: "Expand or collapse context for the selected hunk",
      scopes: REVIEW,
      keyLabels: ["z"],
      match: (key) => key.name === "z" || key.sequence === "z",
      run: () => options.toggleGapForSelectedHunk(),
      closesMenu: true,
    },
    {
      id: "review.editSelectedFile",
      title: "Open the selected file in your editor",
      scopes: REVIEW,
      keyLabels: ["e"],
      match: (key) => key.name === "e" || key.sequence === "e",
      run: () => options.triggerEditSelectedFile(),
      closesMenu: true,
    },
    {
      id: "review.previousHunk",
      title: "Previous hunk",
      scopes: REVIEW,
      keyLabels: ["["],
      match: (key) => key.name === "[",
      run: () => options.moveToHunk(-1),
      closesMenu: true,
    },
    {
      id: "review.nextHunk",
      title: "Next hunk",
      scopes: REVIEW,
      keyLabels: ["]"],
      match: (key) => key.name === "]",
      run: () => options.moveToHunk(1),
      closesMenu: true,
    },
    {
      id: "review.previousFile",
      title: "Previous file",
      scopes: REVIEW,
      keyLabels: [","],
      match: plainKey(","),
      run: () => options.moveToFile(-1),
      closesMenu: true,
    },
    {
      id: "review.nextFile",
      title: "Next file",
      scopes: REVIEW,
      keyLabels: ["."],
      match: plainKey("."),
      run: () => options.moveToFile(1),
      closesMenu: true,
    },
    {
      id: "review.previousAnnotatedHunk",
      title: "Previous annotated hunk",
      scopes: REVIEW,
      keyLabels: ["{"],
      match: (key) => key.sequence === "{",
      run: () => options.moveToAnnotatedHunk(-1),
      closesMenu: true,
    },
    {
      id: "review.nextAnnotatedHunk",
      title: "Next annotated hunk",
      scopes: REVIEW,
      keyLabels: ["}"],
      match: (key) => key.sequence === "}",
      run: () => options.moveToAnnotatedHunk(1),
      closesMenu: true,
    },
  ];
}

let cachedMatchProbes: AppCommand[] | undefined;

/**
 * The built-in command table over no-op callbacks, for chord-conflict probing.
 *
 * Matchers are pure functions of the key event and never change between
 * sessions, so one cached table answers "does a built-in own this key?"
 * without threading live callbacks anywhere near conflict detection.
 */
export function builtinCommandMatchProbes(): readonly AppCommand[] {
  if (!cachedMatchProbes) {
    const noop = () => {};
    cachedMatchProbes = buildAppCommands({
      canRefreshCurrentInput: true,
      focusFilter: noop,
      moveToAnnotatedHunk: noop,
      moveToFile: noop,
      moveToHunk: noop,
      openThemeSelector: noop,
      requestQuit: noop,
      scrollCodeHorizontally: noop,
      scrollDiff: noop,
      selectLayoutMode: noop,
      startUserNote: noop,
      toggleAgentNotes: noop,
      toggleFocusArea: noop,
      toggleGapForSelectedHunk: noop,
      toggleHelp: noop,
      toggleHunkHeaders: noop,
      toggleLineNumbers: noop,
      toggleLineWrap: noop,
      toggleMenuBar: noop,
      toggleSidebar: noop,
      triggerEditSelectedFile: noop,
      triggerRefreshCurrentInput: noop,
    });
  }

  return cachedMatchProbes;
}

/**
 * Run the first enabled command matching one key in one scope.
 *
 * First match wins, exactly as the old if-cascade did. The matched command is
 * returned so the caller can honor `closesMenu` — the menu belongs to the
 * keyboard hook, not the table.
 */
export function dispatchAppCommand(
  commands: readonly AppCommand[],
  scope: AppCommandScope,
  key: KeyEvent,
): AppCommand | undefined {
  for (const command of commands) {
    if (!command.scopes.includes(scope)) {
      continue;
    }

    if (command.isEnabled && !command.isEnabled()) {
      continue;
    }

    if (!command.match(key)) {
      continue;
    }

    command.run(key);
    return command;
  }

  return undefined;
}
