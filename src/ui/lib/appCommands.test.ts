import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { KeyEvent, type ParsedKey } from "@opentui/core";
import {
  buildAppCommands,
  builtinCommandKeyDefaults,
  dispatchAppCommand,
  executeAppCommand,
  observeAppCommandDispatch,
  verticalCommandDirection,
  type BuildAppCommandsOptions,
  type ResolvedCommandKeys,
} from "./appCommands";
import { APP_COMMAND_CATALOG } from "../../core/run/commandCatalog";
import { buildAppMenus } from "./appMenus";
import { buildHelpSections, HELP_COMMAND_IDS } from "./helpContent";
import { resolveCommandKeys } from "./keymap";

/** Build a key event with the fields command matching reads. */
function keyEvent(fields: Partial<ParsedKey>): KeyEvent {
  return new KeyEvent({
    name: "",
    sequence: "",
    raw: "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    number: false,
    eventType: "press",
    source: "raw",
    ...fields,
  });
}

/** Build the built-in table over recording callbacks, plus the log it writes. */
function createTestCommands(resolvedKeys?: ResolvedCommandKeys) {
  const ran: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      ran.push(args.length > 0 ? `${name}:${args.join(",")}` : name);
    };
  const options: BuildAppCommandsOptions = {
    canAlignCurrentLine: true,
    canApplyFilePresentationToAllMatching: false,
    canRefreshCurrentInput: true,
    alignCurrentLine: record("alignCurrentLine"),
    applyFilePresentationToAllMatching: record("applyFilePresentationToAllMatching"),
    focusFilter: record("focusFilter"),
    focusGotoLine: record("focusGotoLine"),
    moveSelection: record("moveSelection"),
    openAgentSkill: record("openAgentSkill"),
    openThemeSelector: record("openThemeSelector"),
    requestQuit: record("requestQuit"),
    resolvedKeys,
    scrollCodeHorizontally: record("scrollCodeHorizontally"),
    scrollDiff: record("scrollDiff"),
    selectCursorLine: record("selectCursorLine"),
    stepDiffLine: record("stepDiffLine"),
    selectLayoutMode: record("selectLayoutMode"),
    startUserNote: record("startUserNote"),
    toggleAgentNotes: record("toggleAgentNotes"),
    toggleCopyDecorations: record("toggleCopyDecorations"),
    toggleFocusArea: record("toggleFocusArea"),
    toggleGapForSelectedHunk: record("toggleGapForSelectedHunk"),
    toggleHelp: record("toggleHelp"),
    toggleHunkHeaders: record("toggleHunkHeaders"),
    toggleLineNumbers: record("toggleLineNumbers"),
    toggleLineWrap: record("toggleLineWrap"),
    toggleMenuBar: record("toggleMenuBar"),
    toggleFilesPane: record("toggleFilesPane"),
    triggerEditSelectedFile: record("triggerEditSelectedFile"),
    triggerRefreshCurrentInput: record("triggerRefreshCurrentInput"),
  };

  return { commands: buildAppCommands(options), ran };
}

describe("built-in command chords", () => {
  test("every alias of the scroll shortcuts still dispatches", () => {
    const { commands, ran } = createTestCommands();
    const press = (fields: Partial<ParsedKey>) =>
      dispatchAppCommand(commands, keyEvent(fields))?.id;

    expect(press({ name: "pagedown" })).toBe("hunk.review.pageDown");
    expect(press({ name: "space" })).toBe("hunk.review.pageDown");
    expect(press({ name: "f", sequence: "f" })).toBe("hunk.review.pageDown");
    expect(press({ name: "pageup" })).toBe("hunk.review.pageUp");
    expect(press({ name: "b", sequence: "b" })).toBe("hunk.review.pageUp");
    // Shift-Space pages backward, and plain space must not.
    expect(press({ name: "space", shift: true })).toBe("hunk.review.pageUp");
    expect(press({ name: "down" })).toBe("hunk.review.stepDown");
    expect(press({ name: "j", sequence: "j" })).toBe("hunk.review.stepDown");
    expect(press({ name: "up" })).toBe("hunk.review.stepUp");
    expect(press({ name: "k", sequence: "k" })).toBe("hunk.review.stepUp");
    expect(press({ name: "d", sequence: "d" })).toBe("hunk.review.halfPageDown");
    expect(press({ name: "u", sequence: "u" })).toBe("hunk.review.halfPageUp");
    expect(ran).toEqual([
      "scrollDiff:1,viewport",
      "scrollDiff:1,viewport",
      "scrollDiff:1,viewport",
      "scrollDiff:-1,viewport",
      "scrollDiff:-1,viewport",
      "scrollDiff:-1,viewport",
      "stepDiffLine:1",
      "stepDiffLine:1",
      "stepDiffLine:-1",
      "stepDiffLine:-1",
      "scrollDiff:1,half",
      "scrollDiff:-1,half",
    ]);
  });

  test("shifted and unshifted forms stay separate commands", () => {
    const { commands } = createTestCommands();
    const press = (fields: Partial<ParsedKey>) =>
      dispatchAppCommand(commands, keyEvent(fields))?.id;

    expect(press({ name: "g", sequence: "g" })).toBe("hunk.review.jumpToTop");
    expect(press({ name: "g", sequence: "G", shift: true })).toBe("hunk.review.jumpToBottom");
    expect(press({ name: "m", sequence: "m" })).toBe("hunk.view.toggleHunkHeaders");
    expect(press({ name: "m", sequence: "M", shift: true })).toBe("hunk.view.toggleMenuBar");
    // The note shortcut is the unmodified c only.
    expect(press({ name: "c", sequence: "c" })).toBe("hunk.review.startNote");
    expect(press({ name: "c", sequence: "c", ctrl: true })).toBeUndefined();
  });

  test("the shifted arrow scrolls further through the same command", () => {
    const { commands, ran } = createTestCommands();

    dispatchAppCommand(commands, keyEvent({ name: "left" }));
    dispatchAppCommand(commands, keyEvent({ name: "left", shift: true }));
    expect(ran).toEqual(["scrollCodeHorizontally:-1", "scrollCodeHorizontally:-8"]);
  });

  test("reports the vertical direction for every review-navigation alias", () => {
    const { commands, ran } = createTestCommands();

    expect(verticalCommandDirection(commands, keyEvent({ name: "down" }))).toBe(1);
    expect(verticalCommandDirection(commands, keyEvent({ name: "j", sequence: "j" }))).toBe(1);
    expect(verticalCommandDirection(commands, keyEvent({ name: "up" }))).toBe(-1);
    expect(verticalCommandDirection(commands, keyEvent({ name: "k", sequence: "k" }))).toBe(-1);
    expect(verticalCommandDirection(commands, keyEvent({ name: "pagedown" }))).toBe(1);
    expect(verticalCommandDirection(commands, keyEvent({ name: "pageup" }))).toBe(-1);
    expect(verticalCommandDirection(commands, keyEvent({ name: "]", sequence: "]" }))).toBe(1);
    expect(verticalCommandDirection(commands, keyEvent({ name: "[", sequence: "[" }))).toBe(-1);
    expect(
      verticalCommandDirection(commands, keyEvent({ name: "q", sequence: "q" })),
    ).toBeUndefined();
    expect(ran).toEqual([]);
  });

  test("a matched key is claimed so focused OpenTUI widgets cannot scroll it too", () => {
    const { commands } = createTestCommands();
    const press = (fields: Partial<ParsedKey>) => {
      const key = keyEvent(fields);
      dispatchAppCommand(commands, key);
      return key.defaultPrevented;
    };

    expect(press({ name: "j", sequence: "j" })).toBe(true);
    expect(press({ name: "up" })).toBe(true);
    expect(press({ name: "pagedown" })).toBe(true);
    expect(press({ name: "f9" })).toBe(false);
  });

  test("key labels are derived from the chords the command answers to", () => {
    const { commands } = createTestCommands();
    const labels = (id: string) => commands.find((command) => command.id === id)?.keyLabels;

    expect(labels("hunk.review.pageUp")).toEqual(["PageUp", "b", "Shift+Space"]);
    expect(labels("hunk.review.jumpToBottom")).toEqual(["G", "End"]);
    expect(labels("hunk.app.quit")).toEqual(["q"]);
  });
});

describe("built-in commands under user keybindings", () => {
  test("a remapped command answers to its new key and releases the old one", () => {
    const { keys } = resolveCommandKeys({
      defaults: builtinCommandKeyDefaults(),
      userBindings: { "hunk.app.quit": "ctrl+x" },
    });
    const { commands, ran } = createTestCommands(keys);

    expect(dispatchAppCommand(commands, keyEvent({ name: "x", ctrl: true }))?.id).toBe(
      "hunk.app.quit",
    );
    expect(dispatchAppCommand(commands, keyEvent({ name: "q", sequence: "q" }))).toBeUndefined();
    expect(ran).toEqual(["requestQuit"]);
    expect(commands.find((command) => command.id === "hunk.app.quit")?.keyLabels).toEqual([
      "Ctrl+X",
    ]);
  });

  test("uses a user binding for a vertical movement command", () => {
    const { keys } = resolveCommandKeys({
      defaults: builtinCommandKeyDefaults(),
      userBindings: { "hunk.review.stepDown": ["down", "j", "ctrl+n"] },
    });
    const { commands } = createTestCommands(keys);

    expect(verticalCommandDirection(commands, keyEvent({ name: "n", ctrl: true }))).toBe(1);
  });

  test("claiming a key held by default takes it from its old owner only", () => {
    const { keys } = resolveCommandKeys({
      defaults: builtinCommandKeyDefaults(),
      // "f" is one of page-down's three chords.
      userBindings: { "hunk.review.focusFilter": ["f", "/"] },
    });
    const { commands } = createTestCommands(keys);
    const press = (fields: Partial<ParsedKey>) =>
      dispatchAppCommand(commands, keyEvent(fields))?.id;

    expect(press({ name: "f", sequence: "f" })).toBe("hunk.review.focusFilter");
    expect(press({ name: "/", sequence: "/" })).toBe("hunk.review.focusFilter");
    // Page-down keeps the chords nobody claimed.
    expect(press({ name: "space" })).toBe("hunk.review.pageDown");
    expect(press({ name: "pagedown" })).toBe("hunk.review.pageDown");
  });

  test("an unbound command matches nothing", () => {
    const { keys } = resolveCommandKeys({
      defaults: builtinCommandKeyDefaults(),
      userBindings: { "hunk.app.quit": false },
    });
    const { commands } = createTestCommands(keys);

    expect(dispatchAppCommand(commands, keyEvent({ name: "q", sequence: "q" }))).toBeUndefined();
    expect(commands.find((command) => command.id === "hunk.app.quit")?.keyLabels).toEqual([]);
  });
});

describe("builtinCommandKeyDefaults", () => {
  test("keeps the documented command-id table sorted and identical to the runtime catalog", () => {
    const markdown = readFileSync(resolve(import.meta.dir, "../../../docs/keybindings.md"), "utf8");
    const documentedIds = Array.from(
      markdown.matchAll(/^\| `(hunk\.[^`]+)`\s+\|/gm),
      (match) => match[1],
    );
    const { commands } = createTestCommands();
    const sortedRuntimeIds = commands.map((command) => command.id).toSorted();

    expect(documentedIds).toEqual(sortedRuntimeIds);
  });

  test("reports every built-in command with the chords it ships with", () => {
    const defaults = builtinCommandKeyDefaults();
    const { commands } = createTestCommands();

    expect(defaults.map((entry) => entry.id)).toEqual(commands.map((command) => command.id));
    expect(commands.every((command) => command.publicToExtensions)).toBe(true);
    expect(defaults.find((entry) => entry.id === "hunk.review.pageDown")?.defaultKeys).toEqual([
      "pagedown",
      "space",
      "f",
    ]);
    // The menu-only commands ship unbound, and are reported so users can bind them.
    expect(
      defaults
        .filter((entry) => entry.defaultKeys.length === 0)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([
      "hunk.app.openAgentSkill",
      "hunk.review.alignCurrentLineBottom",
      "hunk.review.alignCurrentLineCenter",
      "hunk.review.alignCurrentLineTop",
      "hunk.review.nextAnnotatedFile",
      "hunk.review.previousAnnotatedFile",
      "hunk.view.applyFilePresentationToAllMatching",
      "hunk.view.cursorLineNumber",
      "hunk.view.cursorLineOff",
      "hunk.view.cursorLineRow",
      "hunk.view.toggleCopyDecorations",
    ]);
  });
});

describe("commands that ship unbound", () => {
  test("match no key but stay in the table with no labels", () => {
    const { commands } = createTestCommands();
    const unbound = commands.find((command) => command.id === "hunk.view.toggleCopyDecorations");

    expect(unbound?.keyLabels).toEqual([]);
    expect(unbound?.keys).toEqual([]);
    // A neutral event is what an empty-chord matcher is asked about most often.
    expect(unbound?.match(keyEvent({}))).toBe(false);
  });

  test("become dispatchable once the user binds a key to them", () => {
    const { keys } = resolveCommandKeys({
      defaults: builtinCommandKeyDefaults(),
      userBindings: { "hunk.review.nextAnnotatedFile": "ctrl+n" },
    });
    const { commands, ran } = createTestCommands(keys);

    expect(dispatchAppCommand(commands, keyEvent({ name: "n", ctrl: true }))?.id).toBe(
      "hunk.review.nextAnnotatedFile",
    );
    expect(ran).toEqual(["moveSelection:annotated-file,1"]);
    expect(
      commands.find((command) => command.id === "hunk.review.nextAnnotatedFile")?.keyLabels,
    ).toEqual(["Ctrl+N"]);
  });
});

describe("executeAppCommand", () => {
  test("runs a command by id whatever key it is on", () => {
    const { commands, ran } = createTestCommands();

    expect(executeAppCommand(commands, "hunk.app.quit")).toBe(true);
    // Unbound commands are reachable only this way, which is why menus use it.
    expect(executeAppCommand(commands, "hunk.app.openAgentSkill")).toBe(true);
    expect(ran).toEqual(["requestQuit", "openAgentSkill"]);
  });

  test("executes a compatibility alias through the canonical command", () => {
    const { commands, ran } = createTestCommands();

    expect(executeAppCommand(commands, "hunk.view.toggleSidebar")).toBe(true);
    expect(ran).toEqual(["toggleFilesPane"]);
  });

  test("uses shipped semantics rather than a remapped chord for programmatic execution", () => {
    const { keys } = resolveCommandKeys({
      defaults: builtinCommandKeyDefaults(),
      userBindings: { "hunk.review.scrollCodeLeft": "shift+left" },
    });
    const { commands, ran } = createTestCommands(keys);

    // Invoking by id moves ordinary columns even when the user's only key is the fast shifted form.
    expect(executeAppCommand(commands, "hunk.review.scrollCodeLeft", { count: 3 })).toBe(true);
    // Keyboard Shift+Left retains its accelerated behavior.
    expect(dispatchAppCommand(commands, keyEvent({ name: "left", shift: true }))?.id).toBe(
      "hunk.review.scrollCodeLeft",
    );
    expect(ran).toEqual(["scrollCodeHorizontally:-3", "scrollCodeHorizontally:-8"]);
  });

  test("applies movement counts in one semantic callback", () => {
    const { commands, ran } = createTestCommands();

    expect(executeAppCommand(commands, "hunk.review.nextHunk", { count: 3 })).toBe(true);
    expect(executeAppCommand(commands, "hunk.review.stepUp", { count: 4 })).toBe(true);
    expect(executeAppCommand(commands, "hunk.review.pageDown", { count: 2 })).toBe(true);
    expect(ran).toEqual(["moveSelection:hunk,3", "stepDiffLine:-4", "scrollDiff:2,viewport"]);
  });

  test("runs one-shot commands once regardless of count", () => {
    const { commands, ran } = createTestCommands();

    expect(executeAppCommand(commands, "hunk.app.toggleHelp", { count: 9 })).toBe(true);
    expect(ran).toEqual(["toggleHelp"]);
  });

  test("refuses a disabled command and an id nobody registered", () => {
    const { commands, ran } = createTestCommands();
    const disabled = commands.map((command) =>
      command.id === "hunk.app.refresh" ? { ...command, isEnabled: () => false } : command,
    );

    expect(executeAppCommand(disabled, "hunk.app.refresh")).toBe(false);
    expect(executeAppCommand(commands, "nobody.registered.this")).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe("observeAppCommandDispatch", () => {
  test("observes successful terminal dispatch exactly once with the command id", () => {
    const { commands, ran } = createTestCommands();
    const observed: string[] = [];
    const wrapped = observeAppCommandDispatch(commands, (id) => observed.push(id));

    expect(dispatchAppCommand(wrapped, keyEvent({ name: "q" }))?.id).toBe("hunk.app.quit");
    expect(ran).toEqual(["requestQuit"]);
    expect(observed).toEqual(["hunk.app.quit"]);
  });

  test("does not observe disabled or throwing commands", () => {
    const { commands } = createTestCommands();
    const quit = commands.find((command) => command.id === "hunk.app.quit")!;
    const observed: string[] = [];
    const disabled = observeAppCommandDispatch([{ ...quit, isEnabled: () => false }], (id) =>
      observed.push(id),
    );
    expect(dispatchAppCommand(disabled, keyEvent({ name: "q" }))).toBeUndefined();

    const throwing = observeAppCommandDispatch(
      [
        {
          ...quit,
          run: () => {
            throw new Error("boom");
          },
        },
      ],
      (id) => observed.push(id),
    );
    expect(() => throwing[0]!.run(keyEvent({ name: "q" }), 1)).toThrow("boom");
    expect(observed).toEqual([]);
  });
});

// The command-parity hook (audit F1–F3): every surface that presents a command — the
// terminal's dispatch table, its dropdown menus, its help dialog — must name one the
// shared catalog declares, and the table must present every catalogued command. A command
// added to one client without a catalog entry fails here instead of forking the vocabulary
// between the terminal and the browser palette that renders from the same data.
describe("command catalog parity", () => {
  test("the built-in table is exactly the catalog, in catalog order", () => {
    const { commands } = createTestCommands();

    expect(commands.map((command) => command.id)).toEqual(
      APP_COMMAND_CATALOG.map((entry) => entry.id),
    );
  });

  test("each built-in command carries the catalog's identity", () => {
    const { commands } = createTestCommands();

    for (const entry of APP_COMMAND_CATALOG) {
      const command = commands.find((candidate) => candidate.id === entry.id);
      expect(command?.title).toBe(entry.title);
      expect(command?.aliases).toEqual(entry.aliases);
      expect(command?.defaultKeys).toEqual(entry.defaultKeys);
      expect(command?.keys).toEqual(entry.defaultKeys);
      expect(command?.publicToExtensions).toBe(entry.publicToExtensions);
      expect(Boolean(command?.closesMenu)).toBe(Boolean(entry.closesMenu));
    }
  });

  test("menus and help only name catalogued commands", () => {
    const { commands } = createTestCommands();
    const catalogued = new Set(APP_COMMAND_CATALOG.map((entry) => entry.id));
    const menus = buildAppMenus({
      commands,
      copyDecorations: false,
      cursorLine: "row",
      layoutMode: "auto",
      filesPaneVisible: true,
      showAgentNotes: false,
      showHelp: false,
      showHunkHeaders: true,
      showLineNumbers: true,
      showMenuBar: true,
      wrapLines: false,
    });
    const menuCommandIds = Object.values(menus)
      .flat()
      .flatMap((entry) => (entry.kind === "item" && entry.commandId ? [entry.commandId] : []));

    expect(menuCommandIds.length).toBeGreaterThan(0);
    expect(menuCommandIds.filter((id) => !catalogued.has(id))).toEqual([]);
    expect(
      buildHelpSections(commands)
        .flatMap((section) => section.rows)
        .filter((row) => row.keys.length === 0),
    ).toEqual([]);
    expect(HELP_COMMAND_IDS.filter((id) => !catalogued.has(id))).toEqual([]);
  });
});
