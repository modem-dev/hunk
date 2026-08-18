import { describe, expect, test } from "bun:test";
import type { RegisteredCommand } from "../../extensions/types";
import type { MenuEntry, MenuId } from "../components/chrome/menu";
import {
  buildAppCommands,
  builtinCommandKeyDefaults,
  builtinCommandMatchProbes,
  type AppCommand,
  type BuildAppCommandsOptions,
  type ResolvedCommandKeys,
} from "./appCommands";
import { buildAppMenus, type BuildAppMenusOptions } from "./appMenus";
import { buildExtensionAppCommands } from "./extensionCommands";
import { resolveCommandKeys } from "./keymap";

/** The app-state half of the menu options, so tests only state what they exercise. */
const MENU_STATE: Omit<BuildAppMenusOptions, "commands" | "extensionCommands"> = {
  copyDecorations: true,
  cursorLine: "row" as const,
  layoutMode: "stack",
  filesPaneVisible: false,
  showAgentNotes: true,
  showHelp: false,
  showHunkHeaders: false,
  showLineNumbers: true,
  showMenuBar: true,
  wrapLines: true,
};

/** Build the built-in command table over recording callbacks, plus the log it writes. */
function createTestCommands(overrides: Partial<BuildAppCommandsOptions> = {}) {
  const ran: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      ran.push(args.length > 0 ? `${name}:${args.join(",")}` : name);
    };
  const noop = () => {};
  const commands = buildAppCommands({
    canAlignCurrentLine: true,
    canApplyFilePresentationToAllMatching: false,
    canRefreshCurrentInput: true,
    alignCurrentLine: record("alignCurrentLine"),
    applyFilePresentationToAllMatching: record("applyFilePresentationToAllMatching"),
    focusFilter: noop,
    focusGotoLine: noop,
    moveSelection: record("moveSelection"),
    openAgentSkill: record("openAgentSkill"),
    openThemeSelector: noop,
    requestQuit: record("requestQuit"),
    scrollCodeHorizontally: noop,
    scrollDiff: noop,
    selectCursorLine: noop,
    stepDiffLine: noop,
    selectLayoutMode: noop,
    startUserNote: noop,
    toggleAgentNotes: noop,
    toggleCopyDecorations: record("toggleCopyDecorations"),
    toggleFocusArea: noop,
    toggleGapForSelectedHunk: noop,
    toggleHelp: noop,
    toggleHunkHeaders: noop,
    toggleLineNumbers: noop,
    toggleLineWrap: noop,
    toggleMenuBar: noop,
    toggleFilesPane: record("toggleFilesPane"),
    triggerEditSelectedFile: noop,
    triggerRefreshCurrentInput: noop,
    ...overrides,
  });

  return { commands, ran };
}

function items(entries: MenuEntry[] | undefined) {
  return (entries ?? []).filter(
    (entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item",
  );
}

function entry(menus: Partial<Record<MenuId, MenuEntry[]>>, menuId: MenuId, label: string) {
  const found = items(menus[menuId]).find((item) => item.label === label);
  if (!found) {
    throw new Error(`No "${label}" item in the ${menuId} menu.`);
  }

  return found;
}

/** Register one extension command, as the extension registry would report it. */
function registeredCommand(
  extensionId: string,
  id: string,
  title: string,
  key?: string,
  handler: () => void = () => {},
): RegisteredCommand {
  return { extensionId, command: { id, title, key }, handler };
}

describe("buildAppMenus", () => {
  test("the current-line entries check the active style", () => {
    const { commands } = createTestCommands();

    const checkedFor = (cursorLine: BuildAppMenusOptions["cursorLine"]) =>
      items(buildAppMenus({ commands, ...MENU_STATE, cursorLine }).view)
        .filter((item) => item.checked && item.label.startsWith("Current line:"))
        .map((item) => item.label);

    expect(checkedFor("row")).toEqual(["Current line: full row"]);
    expect(checkedFor("number")).toEqual(["Current line: line number"]);
    expect(checkedFor("off")).toEqual(["Current line: off"]);
  });

  test("labels, hints, and checked state come from the commands and app state", () => {
    const { commands } = createTestCommands();
    const menus = buildAppMenus({ commands, ...MENU_STATE });

    expect(items(menus.file).map((item) => item.label)).toEqual([
      "Toggle files/filter focus",
      "Focus filter",
      "Open file in editor",
      "Reload",
      "Quit",
    ]);
    expect(menus.file?.[0]).toMatchObject({
      kind: "item",
      label: "Toggle files/filter focus",
      hint: "Tab",
    });
    expect(
      items(menus.view)
        .filter((item) => item.checked)
        .map((item) => item.label),
    ).toEqual([
      "Stacked view",
      "Menu bar",
      "Agent notes",
      "Line numbers",
      "Line wrapping",
      "Copy decorations",
      "Current line: full row",
    ]);
    expect(items(menus.view).map((item) => item.label)).toContain("Themes…");
    expect(items(menus.agent).map((item) => item.label)).toEqual([
      "Agent notes",
      "Agent skill",
      "Next annotated file",
      "Previous annotated file",
    ]);
    expect(items(menus.navigate).map((item) => item.hint)).toEqual(["[", "]", ":", "/", "{", "}"]);
  });

  test("every item carries the id of the command it runs", () => {
    const { commands } = createTestCommands();
    const menus = buildAppMenus({ commands, ...MENU_STATE });

    expect(items(menus.file).map((item) => item.commandId)).toEqual([
      "hunk.app.toggleFocusArea",
      "hunk.review.focusFilter",
      "hunk.review.editSelectedFile",
      "hunk.app.refresh",
      "hunk.app.quit",
    ]);
  });

  test("a legacy command alias remaps the canonical menu item", () => {
    const { keys } = resolveCommandKeys({
      defaults: builtinCommandKeyDefaults(),
      userBindings: { "hunk.view.toggleSidebar": "ctrl+b", "hunk.app.quit": false },
    });
    const { commands } = createTestCommands({ resolvedKeys: keys as ResolvedCommandKeys });
    const menus = buildAppMenus({ commands, ...MENU_STATE });

    expect(entry(menus, "view", "Files pane")).toMatchObject({
      commandId: "hunk.view.toggleFilesPane",
      hint: "Ctrl+B",
    });
    // Unbound by the user, and unbound by declaration: neither advertises a key.
    expect(entry(menus, "file", "Quit").hint).toBeUndefined();
    expect(entry(menus, "view", "Copy decorations").hint).toBeUndefined();
  });

  test("menu items dispatch the command they name", () => {
    const { commands, ran } = createTestCommands();
    const menus = buildAppMenus({ commands, ...MENU_STATE });

    entry(menus, "view", "Files pane").action();
    entry(menus, "view", "Copy decorations").action();
    entry(menus, "agent", "Agent skill").action();
    entry(menus, "agent", "Next annotated file").action();
    entry(menus, "agent", "Previous annotated file").action();

    expect(ran).toEqual([
      "toggleFilesPane",
      "toggleCopyDecorations",
      "openAgentSkill",
      "moveSelection:annotated-file,1",
      "moveSelection:annotated-file,-1",
    ]);
  });

  test("dispatches the host-owned changeset-wide file-presentation action", () => {
    const { commands, ran } = createTestCommands({
      canApplyFilePresentationToAllMatching: true,
    });
    const menus = buildAppMenus({
      commands,
      ...MENU_STATE,
      fileViewEntries: [
        {
          kind: "item",
          label: "File presentation: Preview",
          commandId: "hunk.view.filePresentation.preview",
          action: () => {},
        },
      ],
      fileViewApplyAllLabel: 'Apply "Preview" to all matching files',
    });

    const apply = entry(menus, "view", 'Apply "Preview" to all matching files');
    expect(apply.commandId).toBe("hunk.view.applyFilePresentationToAllMatching");
    expect(apply.hint).toBeUndefined();
    apply.action();
    expect(ran).toContain("applyFilePresentationToAllMatching");
  });

  test("Reload disappears when the current input cannot be reloaded", () => {
    const { commands } = createTestCommands({ canRefreshCurrentInput: false });
    const menus = buildAppMenus({ commands, ...MENU_STATE });

    expect(items(menus.file).map((item) => item.label)).toEqual([
      "Toggle files/filter focus",
      "Focus filter",
      "Open file in editor",
      "Quit",
    ]);
  });
});

describe("the Extensions menu", () => {
  /** Build the menus for a session whose extensions registered these commands. */
  function menusWithExtensions(registered: readonly RegisteredCommand[]) {
    const { commands: builtins } = createTestCommands();
    const { commands: extensionCommands } = buildExtensionAppCommands({
      registered,
      builtins: builtinCommandMatchProbes(),
      runCommand: (command) => command.handler({} as never),
    });
    const commands: AppCommand[] = [...builtins, ...extensionCommands];
    return buildAppMenus({ commands, extensionCommands, ...MENU_STATE });
  }

  test("is absent when no extension command or active keyboard mode needs it", () => {
    const { commands } = createTestCommands();

    expect(buildAppMenus({ commands, ...MENU_STATE }).extensions).toBeUndefined();
    expect(menusWithExtensions([]).extensions).toBeUndefined();
  });

  test("offers the host-owned keyboard-mode exit even without extension commands", () => {
    const { commands } = createTestCommands();
    const exits: string[] = [];
    const menus = buildAppMenus({
      commands,
      ...MENU_STATE,
      keyboardModeExitEntry: {
        kind: "item",
        label: "Exit Vim navigation",
        commandId: "hunk.extensions.exitKeyboardMode",
        action: () => exits.push("exit"),
      },
    });

    expect(items(menus.extensions).map((item) => item.label)).toEqual(["Exit Vim navigation"]);
    entry(menus, "extensions", "Exit Vim navigation").action();
    expect(exits).toEqual(["exit"]);
  });

  test("lists every registered command with its title and current key", () => {
    const menus = menusWithExtensions([
      registeredCommand("notes", "sync", "Sync notes", "y"),
      // Refused: "s" already toggles the sidebar, so the command is listed
      // without a key rather than dropped from the menu.
      registeredCommand("notes", "stash", "Stash notes", "s"),
      registeredCommand("notes", "quiet", "Quiet mode"),
    ]);

    expect(items(menus.extensions).map((item) => [item.label, item.hint])).toEqual([
      ["Sync notes", "y"],
      ["Stash notes", undefined],
      ["Quiet mode", undefined],
    ]);
  });

  test("separates one extension's commands from the next", () => {
    const menus = menusWithExtensions([
      registeredCommand("notes", "sync", "Sync notes", "y"),
      registeredCommand("blame", "show", "Show blame", "ctrl+g"),
    ]);

    expect(menus.extensions).toMatchObject([
      { kind: "item", label: "Sync notes" },
      { kind: "separator" },
      { kind: "item", label: "Show blame" },
    ]);
  });

  test("an entry runs the extension's handler", () => {
    const ran: string[] = [];
    const menus = menusWithExtensions([
      registeredCommand("notes", "sync", "Sync notes", "y", () => ran.push("sync")),
      registeredCommand("notes", "quiet", "Quiet mode", undefined, () => ran.push("quiet")),
    ]);

    entry(menus, "extensions", "Sync notes").action();
    // An unbound command has no key to reach it by; the menu still runs it.
    entry(menus, "extensions", "Quiet mode").action();

    expect(ran).toEqual(["sync", "quiet"]);
  });

  test("commands sharing a title stay distinct entries with their own ids", () => {
    // Titles only need to be non-empty, so two extensions can both say
    // "Refresh"; the command id is what keeps the rows and handlers apart.
    const ran: string[] = [];
    const menus = menusWithExtensions([
      registeredCommand("notes", "refresh", "Refresh", "y", () => ran.push("notes")),
      registeredCommand("blame", "refresh", "Refresh", undefined, () => ran.push("blame")),
    ]);

    const rows = items(menus.extensions);
    expect(rows.map((item) => [item.label, item.commandId])).toEqual([
      ["Refresh", "notes.refresh"],
      ["Refresh", "blame.refresh"],
    ]);

    for (const row of rows) {
      row.action();
    }
    expect(ran).toEqual(["notes", "blame"]);
  });
});
