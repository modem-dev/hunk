import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ACTIONS } from "./actions";
import { applyKeymapOverrides, loadKeymapDefaults } from "./load";
import { matchesAction } from "./match";

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

describe("loadKeymapDefaults", () => {
  test("includes every action defined in the registry", () => {
    const keymap = loadKeymapDefaults();
    for (const action of ACTIONS) {
      const specs = keymap[action.scope][action.id];
      expect(specs, `missing ${action.scope}.${action.id}`).toBeDefined();
      expect(specs!.length).toBeGreaterThan(0);
    }
  });
});

describe("applyKeymapOverrides", () => {
  test("replaces the bindings for a single action", () => {
    const base = loadKeymapDefaults();
    const next = applyKeymapOverrides(base, {
      keybindings: {
        global: {
          quit: "x",
        },
      },
    });
    const xKey = makeKey({ name: "x", sequence: "x" });
    const qKey = makeKey({ name: "q", sequence: "q" });
    expect(matchesAction(next, "global", "quit", xKey)).toBe(true);
    expect(matchesAction(next, "global", "quit", qKey)).toBe(false);
  });

  test("disables an action via <disabled>", () => {
    const base = loadKeymapDefaults();
    const next = applyKeymapOverrides(base, {
      keybindings: {
        global: {
          "sidebar.toggle": "<disabled>",
        },
      },
    });
    expect(next.global["sidebar.toggle"]).toEqual([]);
    const sKey = makeKey({ name: "s", sequence: "s" });
    expect(matchesAction(next, "global", "sidebar.toggle", sKey)).toBe(false);
  });

  test("supports array form for multiple keys", () => {
    const base = loadKeymapDefaults();
    const next = applyKeymapOverrides(base, {
      keybindings: {
        global: {
          quit: ["x", "<c-c>"],
        },
      },
    });
    expect(next.global.quit).toHaveLength(2);
    expect(matchesAction(next, "global", "quit", makeKey({ name: "x", sequence: "x" }))).toBe(true);
    expect(
      matchesAction(next, "global", "quit", makeKey({ name: "c", ctrl: true })),
    ).toBe(true);
  });

  test("ignores unknown action ids without throwing", () => {
    const base = loadKeymapDefaults();
    const next = applyKeymapOverrides(base, {
      keybindings: {
        global: {
          "this.does.not.exist": "x",
        },
      },
    });
    // Defaults preserved.
    expect(next.global.quit).toEqual(base.global.quit);
  });

  test("does not mutate the input keymap", () => {
    const base = loadKeymapDefaults();
    const beforeQuit = base.global.quit;
    applyKeymapOverrides(base, {
      keybindings: { global: { quit: "x" } },
    });
    expect(base.global.quit).toBe(beforeQuit);
  });
});
