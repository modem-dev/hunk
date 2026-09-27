import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { TerminalColors } from "../../core/theme/terminalColors";
import { sameTerminalColors, watchTerminalColors } from "./terminalColorWatcher";

const DARK_REPORT = {
  palette: ["#000000", "#f7768e", "#9ece6a"],
  defaultForeground: "#c0caf5",
  defaultBackground: "#1a1b26",
};
const LIGHT_REPORT = {
  palette: ["#000000", "#d20f39", "#40a02b"],
  defaultForeground: "#4c4f69",
  defaultBackground: "#eff1f5",
};

/** Build a fake renderer whose palette probe answers with whatever report is current. */
function createTestPaletteRenderer(report: { current: typeof DARK_REPORT }) {
  const handlers: ((sequence: string) => boolean)[] = [];
  const renderer = {
    probes: 0,
    cacheClears: 0,
    clearPaletteCache() {
      renderer.cacheClears += 1;
    },
    async getPalette() {
      renderer.probes += 1;
      return report.current as never;
    },
    prependInputHandler(handler: (sequence: string) => boolean) {
      handlers.unshift(handler);
    },
    removeInputHandler(handler: (sequence: string) => boolean) {
      handlers.splice(handlers.indexOf(handler), 1);
    },
    feed(sequence: string) {
      return handlers.some((handler) => handler(sequence));
    },
    handlers,
  };
  return renderer;
}

describe("terminal color watcher", () => {
  test("re-probes after a color-scheme notification and reports only changed colors", async () => {
    const report = { current: DARK_REPORT };
    const renderer = createTestPaletteRenderer(report);
    const signals = new EventEmitter();
    let current: TerminalColors | undefined;
    const changes: TerminalColors[] = [];
    const dispose = watchTerminalColors({
      renderer,
      current: () => current,
      onChange: (colors) => {
        current = colors;
        changes.push(colors);
      },
      signals,
    });

    // The notification stays unhandled so OpenTUI can still track light/dark from it.
    expect(renderer.feed("\x1b[?997;1n")).toBe(false);
    expect(renderer.feed("\x1b[?997;1n")).toBe(false);
    await Bun.sleep(150);
    expect(renderer.probes).toBe(1);
    expect(renderer.cacheClears).toBe(1);
    expect(changes).toEqual([
      { foreground: "#c0caf5", background: "#1a1b26", palette: ["#000000", "#f7768e", "#9ece6a"] },
    ]);

    // A resize with unchanged colors probes but reports nothing.
    signals.emit("SIGWINCH");
    await Bun.sleep(150);
    expect(renderer.probes).toBe(2);
    expect(changes).toHaveLength(1);

    // tmux-style: new OSC colors land in the pane, then SIGWINCH arrives.
    report.current = LIGHT_REPORT;
    signals.emit("SIGWINCH");
    await Bun.sleep(150);
    expect(changes.at(-1)).toMatchObject({ background: "#eff1f5", foreground: "#4c4f69" });

    dispose();
    expect(renderer.handlers).toHaveLength(0);
    expect(signals.listenerCount("SIGWINCH")).toBe(0);
  });

  test("probes once at mount when startup never learned the terminal colors", async () => {
    const renderer = createTestPaletteRenderer({ current: DARK_REPORT });
    const changes: TerminalColors[] = [];
    const dispose = watchTerminalColors({
      renderer,
      current: () => undefined,
      onChange: (colors) => changes.push(colors),
      signals: new EventEmitter(),
    });
    await Bun.sleep(150);
    dispose();

    expect(renderer.probes).toBe(1);
    expect(changes).toHaveLength(1);
  });

  test("ignores unrelated input and compares reports by value", () => {
    const renderer = createTestPaletteRenderer({ current: DARK_REPORT });
    const dispose = watchTerminalColors({
      renderer,
      current: () => undefined,
      onChange: () => undefined,
      signals: new EventEmitter(),
    });
    expect(renderer.feed("\x1b[A")).toBe(false);
    dispose();

    const colors = { foreground: "#ffffff", background: "#000000", palette: ["#111111"] };
    expect(sameTerminalColors(colors, { ...colors, palette: ["#111111"] })).toBe(true);
    expect(sameTerminalColors(colors, { ...colors, palette: ["#222222"] })).toBe(false);
    expect(sameTerminalColors(undefined, colors)).toBe(false);
  });
});
