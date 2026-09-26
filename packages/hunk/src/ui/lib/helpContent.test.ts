import { describe, expect, test } from "bun:test";
import { getBundledUIRegistry } from "../../extensions/default/ui";
import {
  builtinCommandKeyDefaults,
  builtinCommandMatchProbes,
  type AppCommand,
} from "./appCommands";
import { buildExtensionAppCommands, extensionCommandKeyDefaults } from "./extensionCommands";
import { buildHelpSections, type HelpSection } from "./helpContent";
import { resolveCommandKeys } from "./keymap";
import { buildSessionCommands } from "./sessionRegistrations";

/** The help rows for a session with the given `[keybindings]` entries and bundled commands. */
function helpSections(userBindings?: Record<string, string | false>): HelpSection[] {
  const bundled = buildSessionCommands(undefined, getBundledUIRegistry());
  const { keys } = resolveCommandKeys({
    defaults: [...builtinCommandKeyDefaults(), ...extensionCommandKeyDefaults(bundled)],
    userBindings,
  });
  const builtins = builtinCommandMatchProbes(keys);
  const { commands } = buildExtensionAppCommands({
    registered: bundled,
    builtins,
    resolvedKeys: keys,
    runCommand: () => {},
  });
  return buildHelpSections([...builtins, ...commands]);
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
    expect(keysFor(sections, "move through lines and notes")).toBe("Up / Down");
    expect(keysFor(sections, "unified / split / auto")).toBe("1 / 2 / 0");
    expect(keysFor(sections, "lines / wrap / metadata / menu")).toBe("l / w / m / M");
    expect(keysFor(sections, "annotated hunk / exact note")).toBe("{ / }");
  });

  test("documents the bundled search keys beside the built-in navigation rows", () => {
    const sections = helpSections();

    expect(keysFor(sections, "search diff content")).toBe("/");
    expect(keysFor(sections, "next / previous search match")).toBe("n / N");
    // The filter ships unbound, so its row disappears rather than advertising nothing.
    expect(keysFor(sections, "focus file filter")).toBeUndefined();
  });

  test("handing / back to the filter takes it from search and shows both truthfully", () => {
    const sections = helpSections({ "hunk.review.focusFilter": "/" });

    expect(keysFor(sections, "focus file filter")).toBe("/");
    expect(keysFor(sections, "search diff content")).toBeUndefined();
    expect(keysFor(sections, "next / previous search match")).toBe("n / N");
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
