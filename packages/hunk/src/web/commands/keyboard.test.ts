import { describe, expect, test } from "bun:test";
import { parseKeyChord, type ParsedKeyChord } from "../../extension-api/keys";
import { APP_COMMAND_CATALOG } from "../../core/run/commandCatalog";
import {
  bindWebCommands,
  bindableWebChords,
  browserReservedChordReason,
  defaultWebKeymap,
  focusOwnsKey,
  webCommandChords,
  webKeyEvent,
  type WebKeyboardEventLike,
} from "./keyboard";
import { buildWebCommands, type WebCommandHandlers } from "./webCommandTable";

/** A DOM-shaped key event with no modifiers unless given. */
function createTestKey(key: string, modifiers: Partial<WebKeyboardEventLike> = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers };
}

/** Parse one chord the test knows is valid. */
function chord(text: string) {
  return parseKeyChord(text) as ParsedKeyChord;
}

/** A minimal element-shaped event target for focus rules. */
function createTestElement(tagName: string, attributes: Record<string, string> = {}) {
  return {
    tagName,
    getAttribute: (name: string) => attributes[name] ?? null,
    isContentEditable: attributes.contenteditable === "true",
    type: attributes.type ?? "",
  } as unknown as EventTarget;
}

/** Build the page's command list with handlers that record what ran. */
function createTestCommands() {
  const ran: string[] = [];
  const handlers = new Proxy({} as WebCommandHandlers, {
    get: (_target, id: string) => () => ran.push(id),
  });
  return { commands: buildWebCommands(handlers), ran };
}

describe("webKeyEvent", () => {
  test("names the keys the chord grammar knows", () => {
    expect(webKeyEvent(createTestKey("ArrowDown"))).toMatchObject({ name: "down" });
    expect(webKeyEvent(createTestKey("PageUp"))).toMatchObject({ name: "pageup" });
    expect(webKeyEvent(createTestKey(" "))).toMatchObject({ name: "space", sequence: " " });
    expect(webKeyEvent(createTestKey("F5"))).toMatchObject({ name: "f5" });
    expect(webKeyEvent(createTestKey("]"))).toMatchObject({ name: "]", sequence: "]" });
  });

  test("ignores modifier presses, dead keys, and composition", () => {
    expect(webKeyEvent(createTestKey("Shift", { shiftKey: true }))).toBeUndefined();
    expect(webKeyEvent(createTestKey("Dead"))).toBeUndefined();
    expect(webKeyEvent(createTestKey("a", { isComposing: true }))).toBeUndefined();
  });

  test("tells a shifted letter from Caps Lock", () => {
    const keymap = defaultWebKeymap();
    const { commands } = createTestCommands();
    const bindings = bindWebCommands(commands, keymap);

    const shifted = webKeyEvent(createTestKey("G", { shiftKey: true }))!;
    expect(bindings.match(shifted)?.entry.id).toBe("hunk.review.jumpToBottom");
    // Caps Lock reports `G` without Shift; it is the `G` chord, never the `g` one.
    const capsLock = webKeyEvent(createTestKey("G"))!;
    expect(bindings.match(capsLock)?.entry.id).toBe("hunk.review.jumpToBottom");
    expect(bindings.match(webKeyEvent(createTestKey("g"))!)?.entry.id).toBe(
      "hunk.review.jumpToTop",
    );
  });
});

describe("browser-reserved chords", () => {
  test("reserves modified chords, Tab, and function keys", () => {
    for (const text of [
      "ctrl+d",
      "ctrl+u",
      "ctrl+s",
      "cmd+f",
      "alt+left",
      "tab",
      "shift+tab",
      "f5",
    ]) {
      expect(browserReservedChordReason(chord(text))).toBeString();
    }
    for (const text of ["d", "G", "space", "shift+space", "[", "pagedown", "shift+left"]) {
      expect(browserReservedChordReason(chord(text))).toBeUndefined();
    }
  });

  test("drops reserved and unparsable chords from what the page binds", () => {
    expect(bindableWebChords(["d", "ctrl+d", "ctlr+x"]).map((parsed) => parsed.base)).toEqual([
      "d",
    ]);
    expect(webCommandChords(defaultWebKeymap(), "hunk.review.halfPageDown")).toEqual(["d"]);
  });

  test("leaves every page command at least one chord the browser does not reserve", () => {
    const keymap = defaultWebKeymap();
    const { commands } = createTestCommands();
    for (const command of commands) {
      if (command.entry.defaultKeys.length === 0) continue;
      // Saving a note ships only `ctrl+s`; a composer saves with Ctrl/Cmd+Enter in its field.
      if (command.entry.id === "hunk.review.saveNote") continue;
      expect(webCommandChords(keymap, command.entry.id).length).toBeGreaterThan(0);
    }
    expect(webCommandChords(keymap, "hunk.review.saveNote")).toEqual([]);
  });

  test("never matches a modified key, even one the keymap carries", () => {
    const { commands } = createTestCommands();
    const keymap = new Map([["hunk.review.nextHunk", ["ctrl+n"]]]);
    const bindings = bindWebCommands(commands, keymap);
    expect(bindings.match(webKeyEvent(createTestKey("n", { ctrlKey: true }))!)).toBeUndefined();
    const plain = bindWebCommands(commands, defaultWebKeymap());
    expect(plain.match(webKeyEvent(createTestKey("f", { ctrlKey: true }))!)).toBeUndefined();
    expect(plain.match(webKeyEvent(createTestKey("[", { metaKey: true }))!)).toBeUndefined();
  });
});

describe("keymap", () => {
  test("starts from the catalog's defaults for every command", () => {
    const keymap = defaultWebKeymap();
    expect([...keymap.keys()]).toEqual(APP_COMMAND_CATALOG.map((entry) => entry.id));
    expect(keymap.get("hunk.review.nextHunk")).toEqual(["]"]);
  });

  test("follows a replacement keymap, as the host's resolved keymap will be", () => {
    const { commands } = createTestCommands();
    const keymap = new Map(defaultWebKeymap());
    keymap.set("hunk.review.nextHunk", ["n"]);
    const bindings = bindWebCommands(commands, keymap);
    expect(bindings.match(webKeyEvent(createTestKey("n"))!)?.entry.id).toBe("hunk.review.nextHunk");
    expect(bindings.match(webKeyEvent(createTestKey("]"))!)).toBeUndefined();
  });

  test("matches symbols however the layout reports Shift", () => {
    const { commands } = createTestCommands();
    const bindings = bindWebCommands(commands, defaultWebKeymap());
    // `{` needs Shift on most layouts; the symbol matches either way.
    expect(bindings.match(webKeyEvent(createTestKey("{", { shiftKey: true }))!)?.entry.id).toBe(
      "hunk.review.previousAnnotatedHunk",
    );
    expect(bindings.match(webKeyEvent(createTestKey(".", { shiftKey: false }))!)?.entry.id).toBe(
      "hunk.review.nextFile",
    );
    expect(bindings.match(webKeyEvent(createTestKey(" ", { shiftKey: true }))!)?.entry.id).toBe(
      "hunk.review.pageUp",
    );
  });
});

describe("focusOwnsKey", () => {
  const key = (name: string) => ({ name });

  test("gives every key to text entry", () => {
    for (const element of [
      createTestElement("INPUT", { type: "text" }),
      createTestElement("TEXTAREA"),
      createTestElement("SELECT"),
      createTestElement("DIV", { contenteditable: "true" }),
    ]) {
      expect(focusOwnsKey([element], key("]"))).toBe(true);
    }
    expect(focusOwnsKey([createTestElement("INPUT", { type: "checkbox" })], key("]"))).toBe(false);
  });

  test("gives Space and Enter to buttons and nothing else", () => {
    const button = createTestElement("BUTTON");
    expect(focusOwnsKey([button], key("space"))).toBe(true);
    expect(focusOwnsKey([button], key("return"))).toBe(true);
    expect(focusOwnsKey([button], key("j"))).toBe(false);
  });

  test("gives navigation keys to composite widgets, including inside a shadow root", () => {
    const option = createTestElement("LI", { role: "option" });
    expect(focusOwnsKey([option], key("down"))).toBe(true);
    expect(focusOwnsKey([option], key("s"))).toBe(false);
    const treeRow = createTestElement("BUTTON");
    const tree = createTestElement("FILE-TREE-CONTAINER");
    expect(focusOwnsKey([createTestElement("SPAN"), tree, treeRow], key("up"))).toBe(true);
  });

  test("ignores targets that are not elements", () => {
    expect(focusOwnsKey([{} as EventTarget], key("space"))).toBe(false);
  });
});
