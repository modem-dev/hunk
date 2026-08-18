import type { CursorLine, LayoutMode } from "../../core/run/commandInputs";
import type { AppMenus, MenuEntry, MenuId } from "../components/chrome/menu";
import { executeAppCommand, isCommandEnabled, type AppCommand } from "./appCommands";

/**
 * The dropdown menus, expressed as references into the command table.
 *
 * A menu item is a command plus presentation: nothing here re-implements an
 * action or re-states which key runs it. Labels and checkbox state are the
 * presentation details the menu owns; App supplies whether the active files
 * pane is visible, and everything else comes from the command it names.
 */

/** One dropdown item, named by the command it runs. */
interface MenuCommandSpec {
  commandId: string;
  /** Short menu wording; defaults to the command's title. */
  label?: string;
  /** Checkbox state, supplied by the caller from live app state. */
  checked?: boolean;
}

type MenuEntrySpec = MenuCommandSpec | { separator: true };

const SEPARATOR: MenuEntrySpec = { separator: true };

/** The app state menu items reflect, beyond what the command table already knows. */
export interface BuildAppMenusOptions {
  /** Every dispatchable command, built-ins first, then extension commands. */
  commands: readonly AppCommand[];
  /** The extension-contributed subset, in registration order, for the Extensions menu. */
  extensionCommands?: readonly AppCommand[];
  /** Host-owned per-file presentation choices appended to View. */
  fileViewEntries?: readonly MenuEntry[];
  /** Host-owned escape hatch shown while a session keyboard mode is active. */
  keyboardModeExitEntry?: MenuEntry;
  /** Live label for the stable host command that applies the selected presentation changeset-wide. */
  fileViewApplyAllLabel?: string;
  copyDecorations: boolean;
  cursorLine: CursorLine;
  layoutMode: LayoutMode;
  filesPaneVisible: boolean;
  showAgentNotes: boolean;
  showHelp: boolean;
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  showMenuBar: boolean;
  wrapLines: boolean;
}

/**
 * Resolve one menu's specs against the command table.
 *
 * An item whose command is missing or currently disabled is dropped rather than
 * shown dead: "Reload" only appears when the current input can be reloaded, and
 * that answer lives on the command's `isEnabled`, not in a second flag here.
 */
function toMenuEntries(
  commands: readonly AppCommand[],
  specs: readonly MenuEntrySpec[],
): MenuEntry[] {
  const entries: MenuEntry[] = [];

  for (const spec of specs) {
    if ("separator" in spec) {
      entries.push({ kind: "separator" });
      continue;
    }

    const command = commands.find((candidate) => candidate.id === spec.commandId);
    if (!command || !isCommandEnabled(command)) {
      continue;
    }

    entries.push({
      kind: "item",
      label: spec.label ?? command.title,
      commandId: spec.commandId,
      // The first resolved chord is the one the menu advertises; a command the
      // user unbound (or that ships unbound) simply shows no key.
      hint: command.keyLabels[0],
      checked: spec.checked,
      action: () => {
        executeAppCommand(commands, spec.commandId);
      },
    });
  }

  return entries;
}

/**
 * The Extensions menu's items, grouped by the extension that registered them.
 *
 * Order follows the command table — extension load order, then registration
 * order within one extension — and a rule between two extensions' groups keeps
 * it readable when several contribute commands.
 */
function toExtensionMenuEntries(
  commands: readonly AppCommand[],
  extensionCommands: readonly AppCommand[],
): MenuEntry[] {
  const specs: MenuEntrySpec[] = [];
  let previousOwner: string | undefined;

  for (const command of extensionCommands) {
    // Extension command ids are `<extensionId>.<commandId>`, and the host
    // refuses extension ids containing dots at load, so the first dot always
    // splits off the owning extension exactly — whatever the command half holds.
    const owner = command.id.slice(0, command.id.indexOf("."));
    if (previousOwner !== undefined && owner !== previousOwner) {
      specs.push(SEPARATOR);
    }

    previousOwner = owner;
    specs.push({ commandId: command.id });
  }

  return toMenuEntries(commands, specs);
}

/** Build the top-level app menus from the command table and the current app state. */
export function buildAppMenus({
  commands,
  extensionCommands = [],
  fileViewEntries = [],
  fileViewApplyAllLabel,
  keyboardModeExitEntry,
  copyDecorations,
  cursorLine,
  layoutMode,
  filesPaneVisible,
  showAgentNotes,
  showHelp,
  showHunkHeaders,
  showLineNumbers,
  showMenuBar,
  wrapLines,
}: BuildAppMenusOptions): AppMenus {
  const specs: Record<Exclude<MenuId, "extensions">, MenuEntrySpec[]> = {
    file: [
      { commandId: "hunk.app.toggleFocusArea", label: "Toggle files/filter focus" },
      { commandId: "hunk.review.focusFilter", label: "Focus filter" },
      { commandId: "hunk.review.editSelectedFile", label: "Open file in editor" },
      { commandId: "hunk.app.refresh", label: "Reload" },
      SEPARATOR,
      { commandId: "hunk.app.quit" },
    ],
    view: [
      { commandId: "hunk.view.layoutSplit", label: "Split view", checked: layoutMode === "split" },
      {
        commandId: "hunk.view.layoutStack",
        label: "Stacked view",
        checked: layoutMode === "stack",
      },
      { commandId: "hunk.view.layoutAuto", checked: layoutMode === "auto" },
      SEPARATOR,
      { commandId: "hunk.view.toggleFilesPane", label: "Files pane", checked: filesPaneVisible },
      { commandId: "hunk.view.toggleMenuBar", label: "Menu bar", checked: showMenuBar },
      SEPARATOR,
      { commandId: "hunk.view.openThemeSelector", label: "Themes…" },
      SEPARATOR,
      { commandId: "hunk.view.toggleAgentNotes", label: "Agent notes", checked: showAgentNotes },
      { commandId: "hunk.view.toggleLineNumbers", label: "Line numbers", checked: showLineNumbers },
      { commandId: "hunk.view.toggleLineWrap", label: "Line wrapping", checked: wrapLines },
      {
        commandId: "hunk.view.toggleHunkHeaders",
        label: "Hunk metadata",
        checked: showHunkHeaders,
      },
      {
        commandId: "hunk.view.toggleCopyDecorations",
        label: "Copy decorations",
        checked: copyDecorations,
      },
      {
        commandId: "hunk.view.cursorLineRow",
        label: "Current line: full row",
        checked: cursorLine === "row",
      },
      {
        commandId: "hunk.view.cursorLineNumber",
        label: "Current line: line number",
        checked: cursorLine === "number",
      },
      {
        commandId: "hunk.view.cursorLineOff",
        label: "Current line: off",
        checked: cursorLine === "off",
      },
    ],
    navigate: [
      { commandId: "hunk.review.previousHunk" },
      { commandId: "hunk.review.nextHunk" },
      SEPARATOR,
      { commandId: "hunk.review.gotoLine", label: "Go to line…" },
      { commandId: "hunk.review.focusFilter", label: "Focus filter" },
      SEPARATOR,
      { commandId: "hunk.review.previousAnnotatedHunk", label: "Previous comment" },
      { commandId: "hunk.review.nextAnnotatedHunk", label: "Next comment" },
    ],
    agent: [
      { commandId: "hunk.view.toggleAgentNotes", label: "Agent notes", checked: showAgentNotes },
      { commandId: "hunk.app.openAgentSkill", label: "Agent skill" },
      SEPARATOR,
      { commandId: "hunk.review.nextAnnotatedFile" },
      { commandId: "hunk.review.previousAnnotatedFile" },
    ],
    help: [{ commandId: "hunk.app.toggleHelp", label: "Controls help", checked: showHelp }],
  };

  if (fileViewEntries.length > 0) {
    specs.view.push(SEPARATOR);
  }

  const extensionCommandEntries = toExtensionMenuEntries(commands, extensionCommands);
  const extensions = keyboardModeExitEntry
    ? [
        keyboardModeExitEntry,
        ...(extensionCommandEntries.length > 0
          ? [{ kind: "separator" as const }, ...extensionCommandEntries]
          : []),
      ]
    : extensionCommandEntries;
  const applyAllEntries = fileViewApplyAllLabel
    ? toMenuEntries(commands, [
        {
          commandId: "hunk.view.applyFilePresentationToAllMatching",
          label: fileViewApplyAllLabel,
        },
      ])
    : [];

  return {
    file: toMenuEntries(commands, specs.file),
    view: [
      ...toMenuEntries(commands, specs.view),
      ...fileViewEntries,
      ...(applyAllEntries.length > 0 ? [{ kind: "separator" as const }, ...applyAllEntries] : []),
    ],
    navigate: toMenuEntries(commands, specs.navigate),
    agent: toMenuEntries(commands, specs.agent),
    // No extension commands means no menu at all, rather than an empty dropdown.
    ...(extensions.length > 0 ? { extensions } : {}),
    help: toMenuEntries(commands, specs.help),
  };
}
