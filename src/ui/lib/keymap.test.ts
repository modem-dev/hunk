import { describe, expect, test } from "bun:test";
import { formatKeyChord, resolveCommandKeys, type CommandKeyDefaults } from "./keymap";

const DEFAULTS: CommandKeyDefaults[] = [
  { id: "app.quit", defaultKeys: ["q"] },
  { id: "review.pageDown", defaultKeys: ["pagedown", "space", "f"] },
  { id: "review.nextHunk", defaultKeys: ["]"] },
  { id: "meta.toggle", defaultKeys: ["y"] },
];

/** Resolve against the shared defaults and return the chords per command. */
function resolve(userBindings: Record<string, string | readonly string[] | false>) {
  const { keys, issues } = resolveCommandKeys({ defaults: DEFAULTS, userBindings });
  return { keys, issues };
}

describe("resolveCommandKeys", () => {
  test("commands keep their defaults with no user config", () => {
    const { keys, issues } = resolveCommandKeys({ defaults: DEFAULTS });
    expect(issues).toEqual([]);
    expect(keys.get("review.pageDown")).toEqual(["pagedown", "space", "f"]);
    expect(keys.get("app.quit")).toEqual(["q"]);
  });

  test("a user entry replaces that command's defaults outright", () => {
    const { keys, issues } = resolve({ "review.pageDown": ["ctrl+d"] });
    expect(issues).toEqual([]);
    // Declarative, not additive: the shipped chords are gone.
    expect(keys.get("review.pageDown")).toEqual(["ctrl+d"]);
    expect(keys.get("app.quit")).toEqual(["q"]);
  });

  test("false unbinds a command", () => {
    expect(resolve({ "app.quit": false }).keys.get("app.quit")).toEqual([]);
    expect(resolve({ "app.quit": [] }).keys.get("app.quit")).toEqual([]);
  });

  test("a user-bound chord is stripped from the command that held it by default", () => {
    const { keys, issues } = resolve({ "meta.toggle": ["f", "ctrl+y"] });
    expect(issues).toEqual([]);
    expect(keys.get("meta.toggle")).toEqual(["f", "ctrl+y"]);
    // Page-down loses only the claimed chord and keeps the rest.
    expect(keys.get("review.pageDown")).toEqual(["pagedown", "space"]);
  });

  test("claiming compares chords by meaning, not spelling", () => {
    const { keys } = resolveCommandKeys({
      defaults: [
        { id: "review.jumpToBottom", defaultKeys: ["G", "end"] },
        { id: "meta.toggle", defaultKeys: [] },
      ],
      userBindings: { "meta.toggle": "shift+g" },
    });

    expect(keys.get("review.jumpToBottom")).toEqual(["end"]);
  });

  test("two user entries claiming one chord warn, and the first wins", () => {
    const { keys, issues } = resolve({ "app.quit": "ctrl+x", "meta.toggle": ["ctrl+x", "ctrl+y"] });

    expect(keys.get("app.quit")).toEqual(["ctrl+x"]);
    expect(keys.get("meta.toggle")).toEqual(["ctrl+y"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.commandId).toBe("meta.toggle");
    expect(issues[0]?.message).toContain('already bound to "app.quit"');
  });

  test("an unparsable chord is an issue and the entry's other chords survive", () => {
    const { keys, issues } = resolve({ "app.quit": ["ctlr+q", "ctrl+q"] });

    expect(keys.get("app.quit")).toEqual(["ctrl+q"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("not a usable key chord");
  });

  test("unknown ids are reported, softly when they look like extension commands", () => {
    const { keys, issues } = resolve({ "app.quti": "x", "ghost.command": "z" });

    // Nothing was bound, and no default lost a chord to a skipped entry.
    expect(keys.has("app.quti")).toBe(false);
    expect(keys.get("app.quit")).toEqual(["q"]);
    expect(issues.map((issue) => issue.commandId)).toEqual(["app.quti", "ghost.command"]);
    expect(issues[0]?.message).toContain('unknown command "app.quti"');
    expect(issues[1]?.message).toContain("the extension may not be loaded");
  });

  test("extension command ids are remappable like built-ins", () => {
    const { keys, issues } = resolve({ "meta.toggle": "ctrl+alt+t" });
    expect(issues).toEqual([]);
    expect(keys.get("meta.toggle")).toEqual(["ctrl+alt+t"]);
  });
});

describe("formatKeyChord", () => {
  test("renders chords the way keyboards label them", () => {
    expect(formatKeyChord("q")).toBe("q");
    expect(formatKeyChord("G")).toBe("G");
    expect(formatKeyChord("ctrl+m")).toBe("Ctrl+M");
    expect(formatKeyChord("pageup")).toBe("PageUp");
    expect(formatKeyChord("shift+space")).toBe("Shift+Space");
    expect(formatKeyChord("f10")).toBe("F10");
    expect(formatKeyChord("alt+left")).toBe("Alt+Left");
    expect(formatKeyChord("{")).toBe("{");
  });

  test("an unparsable chord is shown as written", () => {
    expect(formatKeyChord("ctlr+s")).toBe("ctlr+s");
  });
});
