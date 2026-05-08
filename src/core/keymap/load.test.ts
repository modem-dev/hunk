import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ACTIONS } from "./actions";
import { applyKeymapOverrides, loadKeymapDefaults } from "./load";
import { matchesAction } from "./match";

/**
 * Replace `process.stderr.write` with an in-memory collector for the duration
 * of `fn`. Returns the captured chunks so tests can assert on warning content
 * without leaking warnings into the test runner's output.
 */
async function captureStderr(fn: () => void | Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks;
}

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

  test("warns and skips empty array bindings", async () => {
    const base = loadKeymapDefaults();
    let next!: ReturnType<typeof applyKeymapOverrides>;
    const stderr = await captureStderr(() => {
      next = applyKeymapOverrides(base, {
        keybindings: { global: { quit: [] } },
      });
    });

    // Empty array should be ignored, defaults preserved.
    expect(next.global.quit).toEqual(base.global.quit);
    expect(stderr.some((line) => line.includes("empty binding") && line.includes("global.quit"))).toBe(true);
  });

  test("warns on unknown scope but keeps walking known scopes", async () => {
    const base = loadKeymapDefaults();
    let next!: ReturnType<typeof applyKeymapOverrides>;
    const stderr = await captureStderr(() => {
      next = applyKeymapOverrides(base, {
        keybindings: {
          gloabl: { quit: "x" },
          global: { quit: "z" },
        },
      });
    });

    expect(stderr.some((line) => line.includes('unknown scope "gloabl"'))).toBe(true);
    // Known scope still applied.
    const zKey = makeKey({ name: "z", sequence: "z" });
    expect(matchesAction(next, "global", "quit", zKey)).toBe(true);
  });

  test("pager scope bindings are independent of global overrides", () => {
    const base = loadKeymapDefaults();
    const next = applyKeymapOverrides(base, {
      keybindings: { global: { quit: "x" } },
    });

    // Overriding global quit must not touch the pager scope's quit binding.
    expect(next.pager.quit).toEqual(base.pager.quit);
    const qKey = makeKey({ name: "q", sequence: "q" });
    expect(matchesAction(next, "pager", "quit", qKey)).toBe(true);
  });

  test("rejected tokens warn but still bind the parseable ones", async () => {
    const base = loadKeymapDefaults();
    let next!: ReturnType<typeof applyKeymapOverrides>;
    const stderr = await captureStderr(() => {
      next = applyKeymapOverrides(base, {
        keybindings: { global: { quit: ["q", "<bogus>"] } },
      });
    });

    expect(
      stderr.some(
        (line) =>
          line.includes("<bogus>") && line.includes("global.quit") && line.includes("unrecognized"),
      ),
    ).toBe(true);

    // `q` still binds even though `<bogus>` was dropped.
    const qKey = makeKey({ name: "q", sequence: "q" });
    expect(matchesAction(next, "global", "quit", qKey)).toBe(true);
  });

  test("warns when <disabled> mixes with other tokens", async () => {
    const base = loadKeymapDefaults();
    let next!: ReturnType<typeof applyKeymapOverrides>;
    const stderr = await captureStderr(() => {
      next = applyKeymapOverrides(base, {
        keybindings: { global: { quit: ["q", "<disabled>"] } },
      });
    });

    expect(
      stderr.some(
        (line) =>
          line.includes("global.quit") &&
          line.includes("<disabled>") &&
          line.includes("mixes"),
      ),
    ).toBe(true);
    // Disabled still wins — caller is warned, but the binding ends up empty.
    expect(next.global.quit).toEqual([]);
  });
});
