import { describe, expect, test } from "bun:test";
import {
  createExtensionPaneKeybindings,
  formatKeyChord,
  resolveCommandKeys,
  type CommandKeyDefaults,
} from "./keymap";

const DEFAULTS: CommandKeyDefaults[] = [
  { id: "hunk.app.quit", defaultKeys: ["q"] },
  { id: "hunk.review.pageDown", defaultKeys: ["pagedown", "space", "f"] },
  { id: "hunk.review.nextHunk", defaultKeys: ["]"] },
  {
    id: "hunk.view.toggleFilesPane",
    aliases: ["hunk.view.toggleSidebar"],
    defaultKeys: ["s"],
  },
  // A loaded extension's command, under that extension's own id.
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
    expect(keys.get("hunk.review.pageDown")).toEqual(["pagedown", "space", "f"]);
    expect(keys.get("hunk.app.quit")).toEqual(["q"]);
  });

  test("a user entry replaces that command's defaults outright", () => {
    const { keys, issues } = resolve({ "hunk.review.pageDown": ["ctrl+d"] });
    expect(issues).toEqual([]);
    // Declarative, not additive: the shipped chords are gone.
    expect(keys.get("hunk.review.pageDown")).toEqual(["ctrl+d"]);
    expect(keys.get("hunk.app.quit")).toEqual(["q"]);
  });

  test("false unbinds a command", () => {
    expect(resolve({ "hunk.app.quit": false }).keys.get("hunk.app.quit")).toEqual([]);
    expect(resolve({ "hunk.app.quit": [] }).keys.get("hunk.app.quit")).toEqual([]);
  });

  test("a legacy alias remaps the canonical command and mirrors its resolved keys", () => {
    const { keys, issues } = resolve({ "hunk.view.toggleSidebar": "ctrl+b" });

    expect(issues).toEqual([]);
    expect(keys.get("hunk.view.toggleFilesPane")).toEqual(["ctrl+b"]);
    expect(keys.get("hunk.view.toggleSidebar")).toEqual(["ctrl+b"]);
  });

  test("the first config entry wins when an alias and canonical id both appear", () => {
    const { keys, issues } = resolve({
      "hunk.view.toggleSidebar": "ctrl+b",
      "hunk.view.toggleFilesPane": "f6",
    });

    expect(keys.get("hunk.view.toggleFilesPane")).toEqual(["ctrl+b"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('"hunk.view.toggleSidebar" already configures');
  });

  test("a user-bound chord is stripped from the command that held it by default", () => {
    const { keys, issues } = resolve({ "meta.toggle": ["f", "ctrl+y"] });
    expect(issues).toEqual([]);
    expect(keys.get("meta.toggle")).toEqual(["f", "ctrl+y"]);
    // Page-down loses only the claimed chord and keeps the rest.
    expect(keys.get("hunk.review.pageDown")).toEqual(["pagedown", "space"]);
  });

  test("claiming compares chords by meaning, not spelling", () => {
    const { keys } = resolveCommandKeys({
      defaults: [
        { id: "hunk.review.jumpToBottom", defaultKeys: ["G", "end"] },
        { id: "meta.toggle", defaultKeys: [] },
      ],
      userBindings: { "meta.toggle": "shift+g" },
    });

    expect(keys.get("hunk.review.jumpToBottom")).toEqual(["end"]);
  });

  test("two user entries claiming one chord warn, and the first wins", () => {
    const { keys, issues } = resolve({
      "hunk.app.quit": "ctrl+x",
      "meta.toggle": ["ctrl+x", "ctrl+y"],
    });

    expect(keys.get("hunk.app.quit")).toEqual(["ctrl+x"]);
    expect(keys.get("meta.toggle")).toEqual(["ctrl+y"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.commandId).toBe("meta.toggle");
    expect(issues[0]?.message).toContain('already bound to "hunk.app.quit"');
  });

  test("an unparsable chord is an issue and the entry's other chords survive", () => {
    const { keys, issues } = resolve({ "hunk.app.quit": ["ctlr+q", "ctrl+q"] });

    expect(keys.get("hunk.app.quit")).toEqual(["ctrl+q"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("not a usable key chord");
  });

  test("unknown ids are reported, softly when they look like extension commands", () => {
    const { keys, issues } = resolve({ "hunk.app.quti": "x", "ghost.command": "z" });

    // Nothing was bound, and no default lost a chord to a skipped entry.
    expect(keys.has("hunk.app.quti")).toBe(false);
    expect(keys.get("hunk.app.quit")).toEqual(["q"]);
    expect(issues.map((issue) => issue.commandId)).toEqual(["hunk.app.quti", "ghost.command"]);
    expect(issues[0]?.message).toContain('unknown command "hunk.app.quti"');
    expect(issues[1]?.message).toContain("the extension may not be loaded");
  });

  test("an id under a loaded extension is a typo, not an absent extension", () => {
    const { issues } = resolve({ "meta.togle": "z" });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('unknown command "meta.togle"');
    expect(issues[0]?.message).not.toContain("may not be loaded");
  });

  test("an id under the vendor namespace is always a typo", () => {
    // `hunk` is a reserved extension id, so nothing on disk can be the missing
    // owner of a `hunk.` command — the built-in table here is the whole story.
    const { issues } = resolveCommandKeys({
      defaults: [{ id: "meta.toggle", defaultKeys: ["y"] }],
      userBindings: { "hunk.review.nextHnuk": "z" },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('unknown command "hunk.review.nextHnuk"');
    expect(issues[0]?.message).not.toContain("may not be loaded");
  });

  test("duplicate ids in the command table keep the first entry's keys", () => {
    const { keys, issues } = resolveCommandKeys({
      defaults: [
        { id: "meta.toggle", defaultKeys: ["y"] },
        { id: "meta.toggle", defaultKeys: ["z"] },
      ],
    });

    expect(keys.get("meta.toggle")).toEqual(["y"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.commandId).toBe("meta.toggle");
    expect(issues[0]?.message).toContain("Duplicate command id");
  });

  test("extension command ids are remappable like built-ins", () => {
    const { keys, issues } = resolve({ "meta.toggle": "ctrl+alt+t" });
    expect(issues).toEqual([]);
    expect(keys.get("meta.toggle")).toEqual(["ctrl+alt+t"]);
  });
});

describe("extension pane keybindings", () => {
  test("matches resolved commands and exposes their effective chords", () => {
    const { keys } = resolve({ "hunk.review.nextHunk": "ctrl+n", "hunk.app.quit": false });
    const keybindings = createExtensionPaneKeybindings(keys);

    expect(keybindings.getKeys("hunk.review.nextHunk")).toEqual(["ctrl+n"]);
    expect(keybindings.matches({ name: "n", ctrl: true }, "hunk.review.nextHunk")).toBe(true);
    // The manager follows user remaps, so the shipped bracket chord is gone.
    expect(keybindings.matches({ sequence: "]" }, "hunk.review.nextHunk")).toBe(false);
    expect(keybindings.getKeys("hunk.app.quit")).toEqual([]);
    expect(keybindings.matches({ name: "q" }, "hunk.app.quit")).toBe(false);
    expect(keybindings.getKeys("hunk.view.toggleSidebar")).toEqual(["s"]);
    expect(keybindings.matches({ name: "s" }, "hunk.view.toggleSidebar")).toBe(true);
  });

  test("treats unknown command ids as unbound", () => {
    const { keys } = resolveCommandKeys({ defaults: DEFAULTS });
    const keybindings = createExtensionPaneKeybindings(keys);

    expect(keybindings.getKeys("missing.command")).toEqual([]);
    expect(keybindings.matches({ name: "q" }, "missing.command")).toBe(false);
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
