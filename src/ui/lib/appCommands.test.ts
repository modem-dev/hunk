import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  buildAppCommands,
  builtinCommandKeyDefaults,
  dispatchAppCommand,
  type BuildAppCommandsOptions,
  type ResolvedCommandKeys,
} from "./appCommands";
import { resolveCommandKeys } from "./keymap";

/** Build a key event with the fields command matching reads. */
function keyEvent(fields: Partial<KeyEvent>): KeyEvent {
  return {
    name: "",
    sequence: "",
    raw: "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    ...fields,
  } as KeyEvent;
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
    canRefreshCurrentInput: true,
    focusFilter: record("focusFilter"),
    moveToAnnotatedHunk: record("moveToAnnotatedHunk"),
    moveToFile: record("moveToFile"),
    moveToHunk: record("moveToHunk"),
    openThemeSelector: record("openThemeSelector"),
    requestQuit: record("requestQuit"),
    resolvedKeys,
    scrollCodeHorizontally: record("scrollCodeHorizontally"),
    scrollDiff: record("scrollDiff"),
    selectLayoutMode: record("selectLayoutMode"),
    startUserNote: record("startUserNote"),
    toggleAgentNotes: record("toggleAgentNotes"),
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
    const press = (fields: Partial<KeyEvent>) =>
      dispatchAppCommand(commands, "review", keyEvent(fields))?.id;

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
      "scrollDiff:1,step",
      "scrollDiff:1,step",
      "scrollDiff:-1,step",
      "scrollDiff:-1,step",
      "scrollDiff:1,half",
      "scrollDiff:-1,half",
    ]);
  });

  test("shifted and unshifted forms stay separate commands", () => {
    const { commands } = createTestCommands();
    const press = (fields: Partial<KeyEvent>) =>
      dispatchAppCommand(commands, "review", keyEvent(fields))?.id;

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

    dispatchAppCommand(commands, "review", keyEvent({ name: "left" }));
    dispatchAppCommand(commands, "review", keyEvent({ name: "left", shift: true }));
    expect(ran).toEqual(["scrollCodeHorizontally:-1", "scrollCodeHorizontally:-8"]);
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

    expect(dispatchAppCommand(commands, "review", keyEvent({ name: "x", ctrl: true }))?.id).toBe(
      "hunk.app.quit",
    );
    expect(
      dispatchAppCommand(commands, "review", keyEvent({ name: "q", sequence: "q" })),
    ).toBeUndefined();
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
    const press = (fields: Partial<KeyEvent>) =>
      dispatchAppCommand(commands, "review", keyEvent(fields))?.id;

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

    expect(
      dispatchAppCommand(commands, "review", keyEvent({ name: "q", sequence: "q" })),
    ).toBeUndefined();
    expect(commands.find((command) => command.id === "hunk.app.quit")?.keyLabels).toEqual([]);
  });
});

describe("builtinCommandKeyDefaults", () => {
  test("reports every built-in command with the chords it ships with", () => {
    const defaults = builtinCommandKeyDefaults();
    const { commands } = createTestCommands();

    expect(defaults.map((entry) => entry.id)).toEqual(commands.map((command) => command.id));
    expect(defaults.every((entry) => entry.defaultKeys.length > 0)).toBe(true);
    expect(defaults.find((entry) => entry.id === "hunk.review.pageDown")?.defaultKeys).toEqual([
      "pagedown",
      "space",
      "f",
    ]);
  });
});
