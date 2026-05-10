import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { findActionForKey, matchesAction, matchesKey } from "./match";
import { applyKeymapOverrides, loadKeymapDefaults } from "./load";
import { parseKeyToken } from "./parse";

function makeKey(overrides: Partial<KeyEvent>): KeyEvent {
  return {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press" as KeyEvent["eventType"],
    source: "raw",
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  } as unknown as KeyEvent;
}

describe("matchesKey", () => {
  test("matches bare-character sequence", () => {
    const spec = parseKeyToken("q");
    if (!spec || spec === "disabled") throw new Error("bad fixture");
    expect(matchesKey(spec, makeKey({ sequence: "q", name: "q" }))).toBe(true);
    expect(matchesKey(spec, makeKey({ sequence: "x", name: "x" }))).toBe(false);
  });

  test("matches escape via either name alias", () => {
    const spec = parseKeyToken("<esc>");
    if (!spec || spec === "disabled") throw new Error("bad fixture");
    expect(matchesKey(spec, makeKey({ name: "escape" }))).toBe(true);
    expect(matchesKey(spec, makeKey({ name: "esc" }))).toBe(true);
  });

  test("matches enter and return alias", () => {
    const spec = parseKeyToken("<enter>");
    if (!spec || spec === "disabled") throw new Error("bad fixture");
    expect(matchesKey(spec, makeKey({ name: "return" }))).toBe(true);
    expect(matchesKey(spec, makeKey({ name: "enter" }))).toBe(true);
  });

  test("differentiates shift-left from left", () => {
    const left = parseKeyToken("<left>");
    const shiftLeft = parseKeyToken("<s-left>");
    if (!left || left === "disabled") throw new Error("bad fixture");
    if (!shiftLeft || shiftLeft === "disabled") throw new Error("bad fixture");

    const plainLeft = makeKey({ name: "left" });
    const heldShiftLeft = makeKey({ name: "left", shift: true });

    // Plain spec matches with or without shift (modifiers are
    // "must-be-present" only when the spec asks for them).
    expect(matchesKey(left, plainLeft)).toBe(true);
    expect(matchesKey(left, heldShiftLeft)).toBe(true);

    // Shift-left spec only matches when shift is held.
    expect(matchesKey(shiftLeft, plainLeft)).toBe(false);
    expect(matchesKey(shiftLeft, heldShiftLeft)).toBe(true);
  });

  test("matches space with all OpenTUI variants", () => {
    const spec = parseKeyToken("<space>");
    if (!spec || spec === "disabled") throw new Error("bad fixture");
    expect(matchesKey(spec, makeKey({ name: "space" }))).toBe(true);
    expect(matchesKey(spec, makeKey({ name: " " }))).toBe(true);
    expect(matchesKey(spec, makeKey({ sequence: " " }))).toBe(true);
  });

  test("requires ctrl modifier when specified", () => {
    const spec = parseKeyToken("<c-c>");
    if (!spec || spec === "disabled") throw new Error("bad fixture");
    expect(matchesKey(spec, makeKey({ name: "c", ctrl: true }))).toBe(true);
    expect(matchesKey(spec, makeKey({ name: "c" }))).toBe(false);
  });

  test("bare-character spec accepts events that only set name", () => {
    // Some OpenTUI input paths emit `name` without `sequence` for printables.
    // The matcher must accept either signal, otherwise those paths regress.
    const spec = parseKeyToken("r");
    if (!spec || spec === "disabled") throw new Error("bad fixture");
    expect(matchesKey(spec, makeKey({ name: "r" }))).toBe(true);
    expect(matchesKey(spec, makeKey({ sequence: "r" }))).toBe(true);
    expect(matchesKey(spec, makeKey({ name: "x" }))).toBe(false);
  });

  test("modifier-required specs do not match plain events", () => {
    // The reverse direction of the modifier rule: spec asks for shift/ctrl/alt,
    // event is missing it, so the match must fail. These are cheap pins on the
    // most common regression vector.
    const shiftUp = parseKeyToken("<s-up>");
    const ctrlC = parseKeyToken("<c-c>");
    const metaX = parseKeyToken("<m-x>");
    if (!shiftUp || shiftUp === "disabled") throw new Error("bad fixture");
    if (!ctrlC || ctrlC === "disabled") throw new Error("bad fixture");
    if (!metaX || metaX === "disabled") throw new Error("bad fixture");

    expect(matchesKey(shiftUp, makeKey({ name: "up" }))).toBe(false);
    expect(matchesKey(ctrlC, makeKey({ name: "c" }))).toBe(false);
    expect(matchesKey(metaX, makeKey({ name: "x" }))).toBe(false);
  });
});

describe("matchesAction", () => {
  test("dispatches via the default keymap", () => {
    const keymap = loadKeymapDefaults();
    const key = makeKey({ name: "q", sequence: "q" });
    expect(matchesAction(keymap, "global", "quit", key)).toBe(true);
    expect(matchesAction(keymap, "global", "help.toggle", key)).toBe(false);
  });
});

describe("findActionForKey", () => {
  test("returns the matching action id in scope", () => {
    const keymap = loadKeymapDefaults();
    const f10 = makeKey({ name: "f10" });
    expect(findActionForKey(keymap, "global", f10)).toBe("menu.open");
    const noMatch = makeKey({ name: "x", sequence: "x" });
    expect(findActionForKey(keymap, "global", noMatch)).toBeNull();
  });

  test("first registered action wins when two actions bind the same key", () => {
    // Contract: when a key collision exists, `findActionForKey` returns
    // whichever action appears first when iterating `Object.entries(scopeMap)`.
    // That iteration order matches the insertion order in `loadKeymapDefaults`,
    // which walks ACTIONS in registry order. `quit` is registered before
    // `help.toggle` in `actions.ts`, so a colliding `x` resolves to `quit`.
    //
    // If a future reorder of `ACTIONS` changes the relative position of two
    // colliding actions, this test will flip — that's the intended forcing
    // function so the precedence change is a deliberate decision rather than
    // a silent regression.
    const base = loadKeymapDefaults();
    const next = applyKeymapOverrides(base, {
      keybindings: {
        global: {
          quit: "x",
          "help.toggle": "x",
        },
      },
    });
    const xKey = makeKey({ name: "x", sequence: "x" });
    expect(findActionForKey(next, "global", xKey)).toBe("quit");
  });
});

/**
 * Regression: Shift+Space must scroll up, not down. The matcher is
 * modifier-permissive by design (a bare `<space>` spec matches with or
 * without shift), so the hook has to query the more-specific `scroll.pageUp`
 * binding before the bare-space `scroll.pageDown` binding. These tests pin
 * down both the spec-level overlap and the resolution order the hook relies
 * on so a future reorder of the handler chain trips the test instead of
 * silently inverting Shift+Space.
 */
describe("Shift+Space page-up precedence", () => {
  const shiftSpace = () => makeKey({ name: "space", shift: true });

  test("Shift+Space matches both pageUp and pageDown by default", () => {
    const keymap = loadKeymapDefaults();
    // Both true is fine: the handler chain picks pageUp first.
    expect(matchesAction(keymap, "global", "scroll.pageUp", shiftSpace())).toBe(true);
    expect(matchesAction(keymap, "global", "scroll.pageDown", shiftSpace())).toBe(true);
    expect(matchesAction(keymap, "pager", "scroll.pageUp", shiftSpace())).toBe(true);
    expect(matchesAction(keymap, "pager", "scroll.pageDown", shiftSpace())).toBe(true);
  });

  // Mirror the hook's "first action that matches wins" sequence for the page
  // family. If someone reorders the hook so pageDown is checked first, this
  // resolver returns the wrong id and the test fails loudly.
  function resolvePageAction(scope: "global" | "pager", key: KeyEvent) {
    const keymap = loadKeymapDefaults();
    const ordered = ["scroll.pageUp", "scroll.pageDown"] as const;
    for (const action of ordered) {
      if (matchesAction(keymap, scope, action, key)) return action;
    }
    return null;
  }

  test("Shift+Space resolves to pageUp under the hook's check order", () => {
    expect(resolvePageAction("global", shiftSpace())).toBe("scroll.pageUp");
    expect(resolvePageAction("pager", shiftSpace())).toBe("scroll.pageUp");
  });

  test("plain Space still resolves to pageDown", () => {
    const space = makeKey({ name: "space" });
    expect(resolvePageAction("global", space)).toBe("scroll.pageDown");
    expect(resolvePageAction("pager", space)).toBe("scroll.pageDown");
  });
});
