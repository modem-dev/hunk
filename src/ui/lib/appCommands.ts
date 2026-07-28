import type { KeyEvent } from "@opentui/core";
import type { LayoutMode } from "../../core/types";
import {
  matchesAnyKeyChord,
  parseKeyChordOrUndefined,
  synthesizeKeyEvent,
} from "../../lib/commandKeys";
import { formatKeyChord, type CommandKeyDefaults } from "./keymap";

type ScrollUnit = "step" | "viewport" | "content" | "half";

/** Top-level input scopes a command can be active in. */
export type AppCommandScope = "review" | "pager";

/** Chords each command answers to after user keybindings are folded in, by command id. */
export type ResolvedCommandKeys = ReadonlyMap<string, readonly string[]>;

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
  /**
   * Stable identifier, always namespaced by whoever owns the command.
   *
   * Built-ins live under Hunk's vendor namespace (`hunk.app.quit`,
   * `hunk.review.nextHunk`); extension commands are `<extensionId>.<id>`.
   * Since an extension id is a file stem the user chooses, one reserved vendor
   * namespace is what keeps the two id spaces from ever meeting — an extension
   * called `app.ts` used to be able to mint `app.quit` and shadow a built-in,
   * and any built-in namespace Hunk adds later would have had the same problem.
   */
  id: string;
  title: string;
  scopes: readonly AppCommandScope[];
  /**
   * The chords this command currently answers to, after user keybindings.
   *
   * Empty means the command is unbound: it never matches a key, and is reached
   * only by name through `executeAppCommand` (a menu entry, say).
   */
  keys: readonly string[];
  /** Display form of `keys`, for menus, help, and conflict messages. */
  keyLabels: readonly string[];
  /**
   * The chords this command ships with, before user keybindings.
   *
   * Present means the command is remappable by id from the `[keybindings]`
   * config table, and its matcher and labels are derived from the resolved
   * chords. A command without it matches however it likes and cannot be
   * remapped.
   */
  defaultKeys?: readonly string[];
  /** Report whether the command may run right now; skipped when false. */
  isEnabled?: () => boolean;
  match: (key: KeyEvent) => boolean;
  run: (key: KeyEvent) => void;
  /** Close an open dropdown menu after running. */
  closesMenu?: boolean;
}

/** One built-in command as declared: chords in, matcher and labels derived. */
interface BuiltinCommandSpec {
  id: string;
  title: string;
  scopes: readonly AppCommandScope[];
  /** Chords the command ships with; the user's config may replace them. */
  defaultKeys: readonly string[];
  isEnabled?: () => boolean;
  run: (key: KeyEvent) => void;
  closesMenu?: boolean;
}

/** The callbacks the built-in command set drives; App supplies its own handlers. */
export interface BuildAppCommandsOptions {
  canRefreshCurrentInput: boolean;
  focusFilter: () => void;
  moveToAnnotatedFile: (delta: number) => void;
  moveToAnnotatedHunk: (delta: number) => void;
  moveToFile: (delta: number) => void;
  moveToHunk: (delta: number) => void;
  openAgentSkill: () => void;
  openThemeSelector: () => void;
  requestQuit: () => void;
  /** Chords resolved against the user's `[keybindings]`; defaults apply where absent. */
  resolvedKeys?: ResolvedCommandKeys;
  scrollCodeHorizontally: (delta: number) => void;
  scrollDiff: (delta: number, unit: ScrollUnit) => void;
  selectLayoutMode: (mode: LayoutMode) => void;
  startUserNote: () => void;
  toggleAgentNotes: () => void;
  toggleCopyDecorations: () => void;
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

/**
 * Declare Hunk's built-in commands as ids, titles, and default chords.
 *
 * Every id is `hunk.<group>.<name>`: `hunk.` is the reserved vendor namespace
 * no extension id may take, and the group below it is the menu-level grouping
 * users read in `[keybindings]`.
 *
 * Order is the tiebreaker when several commands could match one key, exactly
 * as the old cascade of if-statements was, so entries keep the old cascade's
 * relative order where it mattered (uppercase before lowercase forms).
 *
 * A few commands ship with no chords at all. They exist because the menus name
 * them: an action reachable by mouse is a command like any other, and declaring
 * it here is what makes it bindable from `[keybindings]` and dispatchable by id.
 */
function builtinCommandSpecs(options: BuildAppCommandsOptions): BuiltinCommandSpec[] {
  return [
    {
      id: "hunk.review.jumpToBottom",
      title: "Jump to end",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["G", "end"],
      run: () => options.scrollDiff(1, "content"),
    },
    {
      id: "hunk.review.jumpToTop",
      title: "Jump to start",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["g", "home"],
      run: () => options.scrollDiff(-1, "content"),
    },
    {
      id: "hunk.app.quit",
      title: "Quit",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["q"],
      run: () => options.requestQuit(),
    },
    {
      id: "hunk.app.toggleHelp",
      title: "Toggle help",
      scopes: REVIEW,
      defaultKeys: ["?"],
      run: () => options.toggleHelp(),
      closesMenu: true,
    },
    {
      id: "hunk.app.openAgentSkill",
      title: "Show agent skill",
      scopes: REVIEW,
      defaultKeys: [],
      run: () => options.openAgentSkill(),
      closesMenu: true,
    },
    {
      id: "hunk.app.toggleFocusArea",
      title: "Switch focus between files and filter",
      scopes: REVIEW,
      defaultKeys: ["tab"],
      run: () => options.toggleFocusArea(),
    },
    {
      id: "hunk.review.focusFilter",
      title: "Focus the file filter",
      scopes: REVIEW,
      defaultKeys: ["/"],
      run: () => options.focusFilter(),
    },
    {
      id: "hunk.review.startNote",
      title: "Add a review note",
      scopes: REVIEW,
      defaultKeys: ["c"],
      run: () => options.startUserNote(),
      closesMenu: true,
    },
    {
      id: "hunk.review.pageDown",
      title: "Scroll down one page",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["pagedown", "space", "f"],
      run: () => options.scrollDiff(1, "viewport"),
    },
    {
      id: "hunk.review.pageUp",
      title: "Scroll up one page",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["pageup", "b", "shift+space"],
      run: () => options.scrollDiff(-1, "viewport"),
    },
    {
      id: "hunk.review.halfPageDown",
      title: "Scroll down half a page",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["d"],
      run: () => options.scrollDiff(1, "half"),
    },
    {
      id: "hunk.review.halfPageUp",
      title: "Scroll up half a page",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["u"],
      run: () => options.scrollDiff(-1, "half"),
    },
    {
      id: "hunk.review.stepDown",
      title: "Scroll down one row",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["down", "j"],
      run: () => options.scrollDiff(1, "step"),
    },
    {
      id: "hunk.review.stepUp",
      title: "Scroll up one row",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["up", "k"],
      run: () => options.scrollDiff(-1, "step"),
    },
    {
      id: "hunk.review.scrollCodeLeft",
      title: "Scroll code left",
      scopes: REVIEW_AND_PAGER,
      // Both chords run the same command; the shifted one scrolls further, so
      // the handler reads the event rather than splitting into two commands.
      defaultKeys: ["left", "shift+left"],
      run: (key) =>
        options.scrollCodeHorizontally(key.shift ? -FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : -1),
    },
    {
      id: "hunk.review.scrollCodeRight",
      title: "Scroll code right",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["right", "shift+right"],
      run: (key) =>
        options.scrollCodeHorizontally(key.shift ? FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : 1),
    },
    {
      id: "hunk.view.layoutSplit",
      title: "Split layout",
      scopes: REVIEW,
      defaultKeys: ["1"],
      run: () => options.selectLayoutMode("split"),
      closesMenu: true,
    },
    {
      id: "hunk.view.layoutStack",
      title: "Stack layout",
      scopes: REVIEW,
      defaultKeys: ["2"],
      run: () => options.selectLayoutMode("stack"),
      closesMenu: true,
    },
    {
      id: "hunk.view.layoutAuto",
      title: "Auto layout",
      scopes: REVIEW,
      defaultKeys: ["0"],
      run: () => options.selectLayoutMode("auto"),
      closesMenu: true,
    },
    {
      id: "hunk.view.toggleSidebar",
      title: "Toggle sidebar",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["s"],
      run: () => options.toggleSidebar(),
      closesMenu: true,
    },
    {
      id: "hunk.app.refresh",
      title: "Refresh the review",
      scopes: REVIEW,
      defaultKeys: ["r"],
      isEnabled: () => options.canRefreshCurrentInput,
      run: () => options.triggerRefreshCurrentInput(),
      closesMenu: true,
    },
    {
      id: "hunk.view.openThemeSelector",
      title: "Choose theme",
      scopes: REVIEW,
      defaultKeys: ["t"],
      run: () => options.openThemeSelector(),
      closesMenu: true,
    },
    {
      id: "hunk.view.toggleAgentNotes",
      title: "Toggle agent notes",
      scopes: REVIEW,
      defaultKeys: ["a"],
      run: () => options.toggleAgentNotes(),
      closesMenu: true,
    },
    {
      id: "hunk.view.toggleLineNumbers",
      title: "Toggle line numbers",
      scopes: REVIEW,
      defaultKeys: ["l"],
      run: () => options.toggleLineNumbers(),
      closesMenu: true,
    },
    {
      id: "hunk.view.toggleLineWrap",
      title: "Toggle line wrapping",
      scopes: REVIEW_AND_PAGER,
      defaultKeys: ["w"],
      run: () => options.toggleLineWrap(),
      closesMenu: true,
    },
    {
      id: "hunk.view.toggleMenuBar",
      title: "Toggle menu bar",
      scopes: REVIEW,
      defaultKeys: ["M"],
      run: () => options.toggleMenuBar(),
      closesMenu: true,
    },
    {
      id: "hunk.view.toggleHunkHeaders",
      title: "Toggle hunk headers",
      scopes: REVIEW,
      defaultKeys: ["m"],
      run: () => options.toggleHunkHeaders(),
      closesMenu: true,
    },
    {
      id: "hunk.view.toggleCopyDecorations",
      title: "Toggle copy decorations",
      scopes: REVIEW,
      defaultKeys: [],
      run: () => options.toggleCopyDecorations(),
      closesMenu: true,
    },
    {
      id: "hunk.review.toggleHunkGap",
      title: "Expand or collapse context for the selected hunk",
      scopes: REVIEW,
      defaultKeys: ["z"],
      run: () => options.toggleGapForSelectedHunk(),
      closesMenu: true,
    },
    {
      id: "hunk.review.editSelectedFile",
      title: "Open the selected file in your editor",
      scopes: REVIEW,
      defaultKeys: ["e"],
      run: () => options.triggerEditSelectedFile(),
      closesMenu: true,
    },
    {
      id: "hunk.review.previousHunk",
      title: "Previous hunk",
      scopes: REVIEW,
      defaultKeys: ["["],
      run: () => options.moveToHunk(-1),
      closesMenu: true,
    },
    {
      id: "hunk.review.nextHunk",
      title: "Next hunk",
      scopes: REVIEW,
      defaultKeys: ["]"],
      run: () => options.moveToHunk(1),
      closesMenu: true,
    },
    {
      id: "hunk.review.previousFile",
      title: "Previous file",
      scopes: REVIEW,
      defaultKeys: [","],
      run: () => options.moveToFile(-1),
      closesMenu: true,
    },
    {
      id: "hunk.review.nextFile",
      title: "Next file",
      scopes: REVIEW,
      defaultKeys: ["."],
      run: () => options.moveToFile(1),
      closesMenu: true,
    },
    {
      id: "hunk.review.previousAnnotatedHunk",
      title: "Previous annotated hunk",
      scopes: REVIEW,
      defaultKeys: ["{"],
      run: () => options.moveToAnnotatedHunk(-1),
      closesMenu: true,
    },
    {
      id: "hunk.review.nextAnnotatedHunk",
      title: "Next annotated hunk",
      scopes: REVIEW,
      defaultKeys: ["}"],
      run: () => options.moveToAnnotatedHunk(1),
      closesMenu: true,
    },
    {
      id: "hunk.review.previousAnnotatedFile",
      title: "Previous annotated file",
      scopes: REVIEW,
      defaultKeys: [],
      run: () => options.moveToAnnotatedFile(-1),
      closesMenu: true,
    },
    {
      id: "hunk.review.nextAnnotatedFile",
      title: "Next annotated file",
      scopes: REVIEW,
      defaultKeys: [],
      run: () => options.moveToAnnotatedFile(1),
      closesMenu: true,
    },
  ];
}

/**
 * Turn one declared command into a dispatchable entry.
 *
 * Matcher and labels both come from the resolved chords, so a remapped command
 * answers to its new key *and* advertises it; a command the user unbound
 * resolves to no chords and simply never matches.
 */
function toAppCommand(spec: BuiltinCommandSpec, resolvedKeys?: ResolvedCommandKeys): AppCommand {
  const keys = resolvedKeys?.get(spec.id) ?? spec.defaultKeys;

  return {
    id: spec.id,
    title: spec.title,
    scopes: spec.scopes,
    defaultKeys: spec.defaultKeys,
    keys,
    keyLabels: keys.map(formatKeyChord),
    isEnabled: spec.isEnabled,
    match: matchesAnyKeyChord(keys),
    run: spec.run,
    closesMenu: spec.closesMenu,
  };
}

/** Build Hunk's built-in command table over live callbacks. */
export function buildAppCommands(options: BuildAppCommandsOptions): AppCommand[] {
  return builtinCommandSpecs(options).map((spec) => toAppCommand(spec, options.resolvedKeys));
}

const NOOP_COMMAND_OPTIONS: BuildAppCommandsOptions = (() => {
  const noop = () => {};
  return {
    canRefreshCurrentInput: true,
    focusFilter: noop,
    moveToAnnotatedFile: noop,
    moveToAnnotatedHunk: noop,
    moveToFile: noop,
    moveToHunk: noop,
    openAgentSkill: noop,
    openThemeSelector: noop,
    requestQuit: noop,
    scrollCodeHorizontally: noop,
    scrollDiff: noop,
    selectLayoutMode: noop,
    startUserNote: noop,
    toggleAgentNotes: noop,
    toggleCopyDecorations: noop,
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
  };
})();

let cachedDefaultProbes: AppCommand[] | undefined;
const cachedResolvedProbes = new WeakMap<ResolvedCommandKeys, AppCommand[]>();

/**
 * The built-in command table over no-op callbacks, for chord-conflict probing.
 *
 * Matchers are a pure function of the resolved chords and never change while a
 * session's keymap holds, so one cached table per keymap answers "does a
 * built-in own this key?" without threading live callbacks anywhere near
 * conflict detection. Cached per keymap identity, because a user rebinding a
 * built-in frees the key it used to hold for an extension to claim.
 */
export function builtinCommandMatchProbes(
  resolvedKeys?: ResolvedCommandKeys,
): readonly AppCommand[] {
  if (!resolvedKeys) {
    cachedDefaultProbes ??= buildAppCommands(NOOP_COMMAND_OPTIONS);
    return cachedDefaultProbes;
  }

  const cached = cachedResolvedProbes.get(resolvedKeys);
  if (cached) {
    return cached;
  }

  const probes = buildAppCommands({ ...NOOP_COMMAND_OPTIONS, resolvedKeys });
  cachedResolvedProbes.set(resolvedKeys, probes);
  return probes;
}

/**
 * Every built-in command's shipped chords, for keymap resolution.
 *
 * Read back off the command table itself so the defaults the user remaps and
 * the defaults the app dispatches can never drift apart.
 */
export function builtinCommandKeyDefaults(): readonly CommandKeyDefaults[] {
  return builtinCommandSpecs(NOOP_COMMAND_OPTIONS).map((spec) => ({
    id: spec.id,
    defaultKeys: spec.defaultKeys,
  }));
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

/**
 * A key event standing in for "the user asked for this command by name".
 *
 * Commands reached without a keypress still take one, because `run` is written
 * against the event a chord produced. Synthesizing the command's own first
 * chord keeps the two paths identical for the handful of commands that read the
 * event (the shifted arrow scrolls further); an unbound command has no chord to
 * synthesize, so it gets a neutral event with no modifiers set.
 */
function commandInvocationEvent(command: AppCommand): KeyEvent {
  const parsed = command.keys.map(parseKeyChordOrUndefined).find((chord) => chord !== undefined);
  return parsed
    ? synthesizeKeyEvent(parsed)
    : synthesizeKeyEvent({ base: "", ctrl: false, meta: false, option: false, shift: false });
}

/**
 * Run one command by id, whatever key it is on.
 *
 * This is the programmatic path into the command table: dropdown menu entries
 * name the command they run rather than closing over a copy of its callback, so
 * a menu item and its shortcut can never drift apart. Reports whether a command
 * ran — an id nobody registered, or one whose `isEnabled` says no, does nothing.
 */
export function executeAppCommand(commands: readonly AppCommand[], id: string): boolean {
  const command = commands.find((candidate) => candidate.id === id);
  if (!command || (command.isEnabled && !command.isEnabled())) {
    return false;
  }

  command.run(commandInvocationEvent(command));
  return true;
}
