import { describe, expect, test } from "bun:test";
import {
  builtinCommandKeyDefaults,
  builtinCommandMatchProbes,
  type AppCommand,
} from "./appCommands";
import { buildHelpSections, type HelpSection } from "./helpContent";
import { resolveCommandKeys } from "./keymap";

/** The help rows for a session with the given `[keybindings]` entries. */
function helpSections(userBindings?: Record<string, string | false>): HelpSection[] {
  const { keys } = resolveCommandKeys({ defaults: builtinCommandKeyDefaults(), userBindings });
  return buildHelpSections(builtinCommandMatchProbes(keys));
}

/** The key column of the row documenting one description. */
function keysFor(sections: HelpSection[], description: string) {
  return sections.flatMap((section) => section.rows).find((row) => row.description === description)
    ?.keys;
}

describe("buildHelpSections", () => {
  test("renders paired rows from each command's primary key", () => {
    const sections = helpSections();

    expect(sections.map((section) => section.title)).toEqual([
      "Navigation",
      "Mouse",
      "View",
      "Review",
    ]);
    expect(keysFor(sections, "previous / next hunk")).toBe("[ / ]");
    expect(keysFor(sections, "half page down / up")).toBe("d / u");
    expect(keysFor(sections, "move line-by-line")).toBe("Up / Down");
    expect(keysFor(sections, "split / stack / auto")).toBe("1 / 2 / 0");
    expect(keysFor(sections, "lines / wrap / metadata / menu")).toBe("l / w / m / M");
  });

  test("a row about one command lists every chord it answers to", () => {
    const sections = helpSections();

    expect(keysFor(sections, "page down")).toBe("PageDown / Space / f");
    expect(keysFor(sections, "page up")).toBe("PageUp / b / Shift+Space");
    expect(keysFor(sections, "jump to start")).toBe("g / Home");
  });

  test("keeps the rows that are not commands at all", () => {
    const sections = helpSections();

    expect(keysFor(sections, "scroll vertically")).toBe("Wheel");
    expect(keysFor(sections, "open menus")).toBe("F10");
  });

  test("a remapped command changes what help advertises", () => {
    const sections = helpSections({
      "hunk.review.nextHunk": "ctrl+n",
      "hunk.app.quit": "ctrl+x",
    });

    expect(keysFor(sections, "previous / next hunk")).toBe("[ / Ctrl+N");
    expect(keysFor(sections, "quit")).toBe("Ctrl+X");
  });

  test("an unbound command drops out of its row, and an empty row drops out entirely", () => {
    const sections = helpSections({
      "hunk.review.previousHunk": false,
      "hunk.review.startNote": false,
    });

    // The pair survives on the half that still has a key.
    expect(keysFor(sections, "previous / next hunk")).toBe("]");
    // Nothing left to document, so the row is gone rather than blank.
    expect(keysFor(sections, "create review note")).toBeUndefined();
  });

  test("a disabled command is documented only while it can run", () => {
    const enabled = builtinCommandMatchProbes();
    const disabled: AppCommand[] = enabled.map((command) =>
      command.id === "hunk.app.refresh" ? { ...command, isEnabled: () => false } : command,
    );

    expect(keysFor(buildHelpSections(enabled), "reload the review")).toBe("r");
    expect(keysFor(buildHelpSections(disabled), "reload the review")).toBeUndefined();
  });
});
