import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { KeyEvent, type ParsedKey } from "@opentui/core";
import {
  buildAppCommands,
  builtinCommandKeyDefaults,
  dispatchAppCommand,
  executeAppCommand,
  type BuildAppCommandsOptions,
  type ResolvedCommandKeys,
} from "./appCommands";
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
    moveToAnnotatedFile: record("moveToAnnotatedFile"),
    moveToAnnotatedHunk: record("moveToAnnotatedHunk"),
    moveToFile: record("moveToFile"),
    moveToHunk: record("moveToHunk"),
    openAgentSkill: record("openAgentSkill"),
    openBrowserReview: record("openBrowserReview"),
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
    toggleSidebar: record("toggleSidebar"),
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
      "hunk.app.openBrowserReview",
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
    expect(ran).toEqual(["moveToAnnotatedFile:1"]);
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
    expect(ran).toEqual(["moveToHunk:3", "stepDiffLine:-4", "scrollDiff:2,viewport"]);
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
