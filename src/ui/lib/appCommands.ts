import type { KeyEvent } from "@opentui/core";
import {
  APP_COMMAND_CATALOG,
  type AppCommandCatalogEntry,
  type AppCommandId,
  type VerticalCommandDirection,
} from "../../core/run/commandCatalog";
import type { ReviewSelectionScope } from "../../core/review/navigation";
import type { CursorLine, LayoutMode } from "../../core/run/commandInputs";
import type { ExtensionCommandExecutionOptions } from "../../extension-api/types";
import {
  matchesAnyKeyChord,
  parseKeyChordOrUndefined,
  synthesizeKeyEvent,
} from "../../lib/commandKeys";
import { formatKeyChord, type CommandKeyDefaults } from "./keymap";

type ScrollUnit = "step" | "viewport" | "content" | "half";

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
export const MAX_APP_COMMAND_COUNT = 10_000;

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
  /** Deprecated ids that resolve to this command without adding dispatch entries. */
  aliases?: readonly string[];
  title: string;
  /**
   * The chords this command currently answers to, after user keybindings.
   *
   * Empty means the command is unbound: it never matches a key, but remains
   * callable by id through `executeAppCommand` and may also appear in a menu.
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
  /** True when extension command controls may invoke this host command by id. */
  publicToExtensions: boolean;
  /** Run once with a host-normalized positive movement count. */
  run: (key: KeyEvent, count: number) => void;
  /** The direction this command moves an ordered UI surface, when it has one. */
  verticalDirection?: VerticalCommandDirection;
  /** Close an open dropdown menu after running. */
  closesMenu?: boolean;
}

/**
 * Observe successful terminal dispatch without moving command identity into review state.
 *
 * Keyboard dispatch, menus, and extension command controls all invoke these
 * entries, while browser/session actions correctly continue through ReviewIntent.
 */
export function observeAppCommandDispatch(
  commands: readonly AppCommand[],
  onDispatched: (commandId: string) => void,
): AppCommand[] {
  return commands.map((command) => ({
    ...command,
    run(key, count) {
      command.run(key, count);
      // AppCommand is deliberately synchronous. Extension handlers may have
      // detached async work still running after terminal dispatch returns.
      onDispatched(command.id);
    },
  }));
}

/** What the terminal does for one catalogued command. */
interface BuiltinCommandHandler {
  /** Report whether the command may run right now; skipped when false. */
  isEnabled?: () => boolean;
  /** Run once with a host-normalized positive movement count and its catalog entry. */
  run: (key: KeyEvent, count: number, entry: AppCommandCatalogEntry) => void;
}

/** The callbacks the built-in command set drives; App supplies its own handlers. */
export interface BuildAppCommandsOptions {
  canAlignCurrentLine: boolean;
  canApplyFilePresentationToAllMatching: boolean;
  canRefreshCurrentInput: boolean;
  alignCurrentLine: (alignment: "top" | "center" | "bottom") => void;
  applyFilePresentationToAllMatching: () => void;
  focusFilter: () => void;
  focusGotoLine: () => void;
  /** Step the review selection through one scope, as the catalog entry declares it. */
  moveSelection: (scope: ReviewSelectionScope, delta: number) => void;
  openAgentSkill: () => void;
  openThemeSelector: () => void;
  requestQuit: () => void;
  /** Chords resolved against the user's `[keybindings]`; defaults apply where absent. */
  resolvedKeys?: ResolvedCommandKeys;
  scrollCodeHorizontally: (delta: number) => void;
  scrollDiff: (delta: number, unit: ScrollUnit) => void;
  stepDiffLine: (delta: number) => void;
  selectCursorLine: (style: CursorLine) => void;
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
  toggleFilesPane: () => void;
  triggerEditSelectedFile: () => void;
  triggerRefreshCurrentInput: () => void;
}

/**
 * Bind Hunk's built-in commands to the terminal's effects.
 *
 * Identity — id, title, chords, category, resolution locus — lives in the shared command
 * catalog, so this table says only what each command *does here*. The map is keyed by
 * `AppCommandId`, which makes the compiler the parity check: a command added to the
 * catalog without a terminal handler, or a handler for a command nobody declared, fails
 * to typecheck rather than silently going missing from menus and help.
 *
 * Semantic navigation commands do not restate their scope or direction: they read the
 * effect their catalog entry declares, which is the same declaration a browser palette
 * and the agent surface lower through.
 */
function runSelectionMove(
  options: BuildAppCommandsOptions,
  entry: AppCommandCatalogEntry,
  count: number,
) {
  const effect = entry.review;
  if (effect?.kind !== "selection/move") {
    return;
  }

  options.moveSelection(effect.scope, effect.direction * count);
}

function builtinCommandHandlers(
  options: BuildAppCommandsOptions,
): Record<AppCommandId, BuiltinCommandHandler> {
  return {
    "hunk.review.jumpToBottom": { run: () => options.scrollDiff(1, "content") },
    "hunk.review.jumpToTop": { run: () => options.scrollDiff(-1, "content") },
    "hunk.app.quit": { run: () => options.requestQuit() },
    "hunk.app.toggleHelp": { run: () => options.toggleHelp() },
    "hunk.app.openAgentSkill": { run: () => options.openAgentSkill() },
    "hunk.app.toggleFocusArea": { run: () => options.toggleFocusArea() },
    "hunk.review.focusFilter": { run: () => options.focusFilter() },
    "hunk.review.gotoLine": { run: () => options.focusGotoLine() },
    "hunk.review.startNote": { run: () => options.startUserNote() },
    "hunk.review.pageDown": { run: (_key, count) => options.scrollDiff(count, "viewport") },
    "hunk.review.pageUp": { run: (_key, count) => options.scrollDiff(-count, "viewport") },
    "hunk.review.halfPageDown": { run: (_key, count) => options.scrollDiff(count, "half") },
    "hunk.review.halfPageUp": { run: (_key, count) => options.scrollDiff(-count, "half") },
    "hunk.review.stepDown": { run: (_key, count) => options.stepDiffLine(count) },
    "hunk.review.stepUp": { run: (_key, count) => options.stepDiffLine(-count) },
    "hunk.review.scrollCodeLeft": {
      run: (key, count) =>
        options.scrollCodeHorizontally(
          (key.shift ? -FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : -1) * count,
        ),
    },
    "hunk.review.scrollCodeRight": {
      run: (key, count) =>
        options.scrollCodeHorizontally(
          (key.shift ? FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : 1) * count,
        ),
    },
    "hunk.review.alignCurrentLineTop": {
      isEnabled: () => options.canAlignCurrentLine,
      run: () => options.alignCurrentLine("top"),
    },
    "hunk.review.alignCurrentLineCenter": {
      isEnabled: () => options.canAlignCurrentLine,
      run: () => options.alignCurrentLine("center"),
    },
    "hunk.review.alignCurrentLineBottom": {
      isEnabled: () => options.canAlignCurrentLine,
      run: () => options.alignCurrentLine("bottom"),
    },
    "hunk.view.cursorLineRow": { run: () => options.selectCursorLine("row") },
    "hunk.view.cursorLineNumber": { run: () => options.selectCursorLine("number") },
    "hunk.view.cursorLineOff": { run: () => options.selectCursorLine("off") },
    "hunk.view.layoutSplit": { run: () => options.selectLayoutMode("split") },
    "hunk.view.layoutStack": { run: () => options.selectLayoutMode("stack") },
    "hunk.view.layoutAuto": { run: () => options.selectLayoutMode("auto") },
    "hunk.view.applyFilePresentationToAllMatching": {
      isEnabled: () => options.canApplyFilePresentationToAllMatching,
      run: () => options.applyFilePresentationToAllMatching(),
    },
    "hunk.view.toggleFilesPane": { run: () => options.toggleFilesPane() },
    "hunk.app.refresh": {
      isEnabled: () => options.canRefreshCurrentInput,
      run: () => options.triggerRefreshCurrentInput(),
    },
    "hunk.view.openThemeSelector": { run: () => options.openThemeSelector() },
    "hunk.view.toggleAgentNotes": { run: () => options.toggleAgentNotes() },
    "hunk.view.toggleLineNumbers": { run: () => options.toggleLineNumbers() },
    "hunk.view.toggleLineWrap": { run: () => options.toggleLineWrap() },
    "hunk.view.toggleMenuBar": { run: () => options.toggleMenuBar() },
    "hunk.view.toggleHunkHeaders": { run: () => options.toggleHunkHeaders() },
    "hunk.view.toggleCopyDecorations": { run: () => options.toggleCopyDecorations() },
    "hunk.review.toggleHunkGap": { run: () => options.toggleGapForSelectedHunk() },
    "hunk.review.editSelectedFile": { run: () => options.triggerEditSelectedFile() },
    "hunk.review.previousHunk": {
      run: (_key, count, entry) => runSelectionMove(options, entry, count),
    },
    "hunk.review.nextHunk": {
      run: (_key, count, entry) => runSelectionMove(options, entry, count),
    },
    "hunk.review.previousFile": {
      run: (_key, count, entry) => runSelectionMove(options, entry, count),
    },
    "hunk.review.nextFile": {
      run: (_key, count, entry) => runSelectionMove(options, entry, count),
    },
    "hunk.review.previousAnnotatedHunk": {
      run: (_key, count, entry) => runSelectionMove(options, entry, count),
    },
    "hunk.review.nextAnnotatedHunk": {
      run: (_key, count, entry) => runSelectionMove(options, entry, count),
    },
    "hunk.review.previousAnnotatedFile": {
      run: (_key, count, entry) => runSelectionMove(options, entry, count),
    },
    "hunk.review.nextAnnotatedFile": {
      run: (_key, count, entry) => runSelectionMove(options, entry, count),
    },
  };
}

/**
 * Turn one declared command into a dispatchable entry.
 *
 * Matcher and labels both come from the resolved chords, so a remapped command
 * answers to its new key *and* advertises it; a command the user unbound
 * resolves to no chords and simply never matches.
 */
function toAppCommand(
  entry: AppCommandCatalogEntry,
  handler: BuiltinCommandHandler,
  resolvedKeys?: ResolvedCommandKeys,
): AppCommand {
  const keys = resolvedKeys?.get(entry.id) ?? entry.defaultKeys;

  return {
    id: entry.id,
    aliases: entry.aliases,
    title: entry.title,
    defaultKeys: entry.defaultKeys,
    keys,
    keyLabels: keys.map(formatKeyChord),
    isEnabled: handler.isEnabled,
    publicToExtensions: entry.publicToExtensions,
    verticalDirection: entry.verticalDirection,
    match: matchesAnyKeyChord(keys),
    run: (key, count) => handler.run(key, count, entry),
    closesMenu: entry.closesMenu,
  };
}

/**
 * Build Hunk's built-in command table: catalogued identity over live callbacks.
 *
 * Order follows the catalog, which is what makes first-match-wins dispatch and the
 * conflict probes below agree with what a browser palette would show.
 */
export function buildAppCommands(options: BuildAppCommandsOptions): AppCommand[] {
  const handlers = builtinCommandHandlers(options);
  // Sound because the handler map is keyed by `AppCommandId` and therefore covers every
  // catalogued id; a missing one is a type error where the map is written, not here.
  return APP_COMMAND_CATALOG.map((entry) =>
    toAppCommand(entry, handlers[entry.id as AppCommandId], options.resolvedKeys),
  );
}

const NOOP_COMMAND_OPTIONS: BuildAppCommandsOptions = (() => {
  const noop = () => {};
  return {
    canAlignCurrentLine: false,
    canApplyFilePresentationToAllMatching: false,
    canRefreshCurrentInput: true,
    alignCurrentLine: noop,
    applyFilePresentationToAllMatching: noop,
    focusFilter: noop,
    focusGotoLine: noop,
    moveSelection: noop,
    openAgentSkill: noop,
    openThemeSelector: noop,
    requestQuit: noop,
    scrollCodeHorizontally: noop,
    scrollDiff: noop,
    stepDiffLine: noop,
    selectCursorLine: noop,
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
    toggleFilesPane: noop,
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
  return APP_COMMAND_CATALOG.map((entry) => ({
    id: entry.id,
    aliases: entry.aliases,
    defaultKeys: entry.defaultKeys,
  }));
}

/**
 * Report whether one command may run right now.
 *
 * The single answer key dispatch, programmatic execution, menu entries, and
 * help rows all consult — a command without a gate is always runnable.
 */
export function isCommandEnabled(command: AppCommand): boolean {
  return !command.isEnabled || command.isEnabled();
}

/**
 * Find the resolved vertical movement binding that matches one key.
 *
 * Modal selectors use the same command table as the review, so built-in aliases and user
 * remaps move the modal instead of dispatching their review action behind it.
 */
export function verticalCommandDirection(
  commands: readonly AppCommand[],
  key: KeyEvent,
): VerticalCommandDirection | undefined {
  for (const command of commands) {
    if (
      command.verticalDirection !== undefined &&
      isCommandEnabled(command) &&
      command.match(key)
    ) {
      return command.verticalDirection;
    }
  }

  return undefined;
}

/**
 * Run the first enabled command matching one key.
 *
 * First match wins, exactly as the old if-cascade did. The matched command is
 * returned so the caller can honor `closesMenu` — the menu belongs to the
 * keyboard hook, not the table.
 */
export function dispatchAppCommand(
  commands: readonly AppCommand[],
  key: KeyEvent,
): AppCommand | undefined {
  for (const command of commands) {
    if (!isCommandEnabled(command)) {
      continue;
    }

    if (!command.match(key)) {
      continue;
    }

    key.preventDefault();
    command.run(key, 1);
    return command;
  }

  return undefined;
}

/**
 * A key event standing in for "the user asked for this command by name".
 *
 * Commands reached without a keypress still take one, because `run` is written
 * against the event a chord produced. Synthesize from the command's shipped
 * first chord rather than the user's resolved binding: invoking a semantic
 * command by id must not change behavior when that command is remapped. An
 * unbound command gets a neutral event with no modifiers set.
 */
function commandInvocationEvent(command: AppCommand): KeyEvent {
  const parsed = (command.defaultKeys ?? [])
    .map(parseKeyChordOrUndefined)
    .find((chord) => chord !== undefined);
  return parsed
    ? synthesizeKeyEvent(parsed)
    : synthesizeKeyEvent({
        base: "",
        ctrl: false,
        meta: false,
        option: false,
        shift: false,
      });
}

/** Validate and normalize a programmatic command count once at the dispatch boundary. */
export function normalizeAppCommandCount(options?: ExtensionCommandExecutionOptions): number {
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new TypeError("Command execution options must be an object.");
  }

  const count = options?.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_APP_COMMAND_COUNT) {
    throw new RangeError(
      `Command execution count must be a positive safe integer no greater than ${MAX_APP_COMMAND_COUNT}.`,
    );
  }

  return count;
}

/**
 * Run one command by id, whatever key it is on.
 *
 * This is the programmatic path into the command table: dropdown menu entries
 * name the command they run rather than closing over a copy of its callback, so
 * a menu item and its shortcut can never drift apart. Reports whether a command
 * ran — an id nobody registered, or one whose `isEnabled` says no, does nothing.
 */
export function executeAppCommand(
  commands: readonly AppCommand[],
  id: string,
  options?: ExtensionCommandExecutionOptions,
): boolean {
  return executeAppCommandWithCount(commands, id, normalizeAppCommandCount(options));
}

/** Find one command by its canonical id or a compatibility alias. */
export function findAppCommandById(
  commands: readonly AppCommand[],
  id: string,
): AppCommand | undefined {
  return commands.find((command) => command.id === id || command.aliases?.includes(id));
}

/** Execute one command after the caller has normalized its count exactly once. */
export function executeAppCommandWithCount(
  commands: readonly AppCommand[],
  id: string,
  count: number,
): boolean {
  const command = findAppCommandById(commands, id);
  if (!command || !isCommandEnabled(command)) {
    return false;
  }

  command.run(commandInvocationEvent(command), count);
  return true;
}
