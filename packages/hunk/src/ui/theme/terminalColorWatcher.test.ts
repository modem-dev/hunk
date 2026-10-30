import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { RendererControlState } from "@opentui/core";
import type { TerminalColors } from "../../core/theme/terminalColors";
import { rendererRawWriter, sameTerminalColors, watchTerminalColors } from "./terminalColorWatcher";

const DA1_REPLY = "\x1b[?62;22c";
const DARK = { foreground: "#c0caf5", background: "#1a1b26", ansi: "#f7768e" };
const LIGHT = { foreground: "#4c4f69", background: "#eff1f5", ansi: "#d20f39" };

/** Encode a #rrggbb color the way xterm answers OSC color queries. */
function createTestRgbSpec(color: string) {
  const channels = [1, 3, 5].map((index) => color.slice(index, index + 2));
  return `rgb:${channels.map((channel) => channel + channel).join("/")}`;
}

/** Build every OSC color reply a terminal sends for one probe, without the DA1 fence. */
function createTestColorReplies(colors: typeof DARK) {
  return [
    `\x1b]10;${createTestRgbSpec(colors.foreground)}\x1b\\`,
    `\x1b]11;${createTestRgbSpec(colors.background)}\x1b\\`,
    ...Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};${colors.ansi}\x07`),
  ];
}

/** Hunk colors for a complete reply set. */
function createTestTerminalColors(colors: typeof DARK): TerminalColors {
  return {
    foreground: colors.foreground,
    background: colors.background,
    palette: Array.from({ length: 16 }, () => colors.ansi),
  };
}

/**
 * Fake renderer that records probe writes and delivers terminal input the way OpenTUI does: OSC
 * subscribers first, then input handlers until one consumes the sequence.
 */
function createTestColorRenderer(options: { palette?: TerminalColors } = {}) {
  const events = new EventEmitter();
  const handlers: ((sequence: string) => boolean)[] = [];
  const subscribers = new Set<(sequence: string) => void>();
  const renderer = {
    writes: [] as string[],
    consumed: [] as string[],
    probes: 0,
    cacheClears: 0,
    isDestroyed: false,
    controlState: RendererControlState.EXPLICIT_STARTED as RendererControlState,
    clearPaletteCache() {
      renderer.cacheClears += 1;
    },
    async getPalette() {
      renderer.probes += 1;
      const palette = options.palette ?? { palette: [] };
      return {
        palette: palette.palette.map((color) => color ?? null),
        defaultForeground: palette.foreground ?? null,
        defaultBackground: palette.background ?? null,
      } as never;
    },
    subscribeOsc(handler: (sequence: string) => void) {
      subscribers.add(handler);
      return () => void subscribers.delete(handler);
    },
    prependInputHandler(handler: (sequence: string) => boolean) {
      handlers.unshift(handler);
    },
    removeInputHandler(handler: (sequence: string) => boolean) {
      handlers.splice(handlers.indexOf(handler), 1);
    },
    on(event: "theme_mode", listener: () => void) {
      events.on(event, listener);
    },
    off(event: "theme_mode", listener: () => void) {
      events.off(event, listener);
    },
    emitThemeMode() {
      events.emit("theme_mode", "dark");
    },
    deliver(...sequences: string[]) {
      for (const sequence of sequences) {
        if (sequence.startsWith("\x1b]")) {
          for (const subscriber of subscribers) subscriber(sequence);
        }
        if (handlers.some((handler) => handler(sequence))) renderer.consumed.push(sequence);
      }
    },
    subscribers,
    handlers,
  };
  return renderer;
}

type TestColorRenderer = ReturnType<typeof createTestColorRenderer>;

/** Start a watcher over the fake renderer with short timings and fences active from mount. */
function startTestWatcher(
  renderer: TestColorRenderer,
  options: {
    initial?: TerminalColors;
    write?: ((data: string) => void) | null;
    probeTimeoutMs?: number;
    fenceExpiryMs?: number;
    startupCapabilityWindowMs?: number;
  } = {},
) {
  let current = "initial" in options ? options.initial : { palette: [] };
  const changes: TerminalColors[] = [];
  const signals = new EventEmitter();
  const dispose = watchTerminalColors({
    renderer,
    current: () => current,
    onChange: (colors) => {
      current = colors;
      changes.push(colors);
    },
    signals,
    write:
      options.write === null
        ? undefined
        : (options.write ?? ((data) => renderer.writes.push(data))),
    debounceMs: 5,
    probeTimeoutMs: options.probeTimeoutMs ?? 200,
    fenceExpiryMs: options.fenceExpiryMs ?? 1000,
    startupCapabilityWindowMs: options.startupCapabilityWindowMs ?? 0,
  });
  return { changes, dispose, signals };
}

/** Let the debounce elapse so a triggered probe is written. */
const waitForTestDebounce = () => Bun.sleep(20);

describe("terminal color watcher", () => {
  test("probes after a notification and finishes on its DA1 fence", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose } = startTestWatcher(renderer);

    renderer.deliver("\x1b[?997;1n", "\x1b[?997;1n");
    // The notification stays unhandled so OpenTUI can still track light/dark from it.
    expect(renderer.consumed).toEqual([]);
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(1);
    expect(renderer.writes[0]).toStartWith("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]4;0;?\x1b\\");
    expect(renderer.writes[0]).toEndWith("\x1b]4;15;?\x1b\\\x1b[c");

    renderer.deliver(...createTestColorReplies(DARK).slice(0, 2), DA1_REPLY);
    expect(changes).toEqual([
      { foreground: DARK.foreground, background: DARK.background, palette: [] },
    ]);
    expect(renderer.consumed).toEqual([DA1_REPLY]);
    expect(renderer.subscribers.size).toBe(0);

    dispose();
    expect(renderer.handlers).toHaveLength(0);
  });

  test("finishes once every color is answered but holds the next probe until the fence returns", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose, signals } = startTestWatcher(renderer);

    signals.emit("SIGWINCH");
    await waitForTestDebounce();
    renderer.deliver(...createTestColorReplies(DARK));
    expect(changes).toEqual([createTestTerminalColors(DARK)]);

    signals.emit("SIGWINCH");
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(1);
    renderer.deliver(DA1_REPLY);
    expect(renderer.consumed).toEqual([DA1_REPLY]);
    expect(renderer.writes).toHaveLength(2);

    // Unchanged colors are not reported again.
    renderer.deliver(...createTestColorReplies(DARK), DA1_REPLY);
    expect(changes).toHaveLength(1);
    dispose();
  });

  test("discards a superseded probe and keeps its late replies out of the re-probe", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose } = startTestWatcher(renderer);

    renderer.deliver("\x1b[?997;1n");
    await waitForTestDebounce();
    // The scheme changes again while the first probe waits on a slow terminal.
    renderer.deliver("\x1b[?997;2n");
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(1);

    // The stale probe closes once its colors arrive but still owes its DA1, and a late reply to
    // OpenTUI's own theme query lands before that fence.
    renderer.deliver(...createTestColorReplies(DARK));
    renderer.deliver(`\x1b]11;${createTestRgbSpec(DARK.background)}\x07`);
    expect(renderer.writes).toHaveLength(1);
    renderer.deliver(DA1_REPLY);
    expect(renderer.writes).toHaveLength(2);
    expect(changes).toHaveLength(0);

    renderer.deliver(...createTestColorReplies(LIGHT).slice(0, 2), DA1_REPLY);
    expect(changes).toEqual([
      { foreground: LIGHT.foreground, background: LIGHT.background, palette: [] },
    ]);
    dispose();
  });

  test("keeps the current colors when the terminal only answers DA1", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose } = startTestWatcher(renderer);

    renderer.deliver("\x1b[?997;2n");
    await waitForTestDebounce();
    renderer.deliver(DA1_REPLY);
    expect(changes).toHaveLength(0);
    expect(renderer.subscribers.size).toBe(0);
    dispose();
  });

  test("leaves foreign DA1 replies to OpenTUI during its startup capability window", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose } = startTestWatcher(renderer, { startupCapabilityWindowMs: 60 });

    renderer.deliver("\x1b[?997;1n");
    await waitForTestDebounce();
    expect(renderer.writes[0]).not.toContain("\x1b[c");
    // OpenTUI's own startup DA1 neither closes the probe nor gets consumed.
    renderer.deliver(DA1_REPLY);
    expect(renderer.consumed).toEqual([]);
    expect(renderer.subscribers.size).toBe(1);
    renderer.deliver(...createTestColorReplies(DARK));
    expect(changes).toEqual([createTestTerminalColors(DARK)]);

    // Once the window closes, probes carry a fence and unrelated DA1 replies still pass through.
    await Bun.sleep(80);
    renderer.deliver(DA1_REPLY);
    expect(renderer.consumed).toEqual([]);
    renderer.deliver("\x1b[?997;1n");
    await waitForTestDebounce();
    expect(renderer.writes[1]).toEndWith("\x1b[c");
    dispose();
  });

  test("keeps a timed-out probe's fence owed so a late DA1 cannot close the next probe", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose } = startTestWatcher(renderer, { probeTimeoutMs: 30 });

    renderer.deliver("\x1b[?997;1n");
    await Bun.sleep(60);
    expect(renderer.subscribers.size).toBe(0);

    renderer.deliver("\x1b[?997;2n");
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(1);
    // The first probe's DA1 finally arrives; it releases the next probe instead of closing it.
    renderer.deliver(DA1_REPLY);
    expect(renderer.writes).toHaveLength(2);
    expect(renderer.subscribers.size).toBe(1);

    renderer.deliver(...createTestColorReplies(LIGHT).slice(0, 2), DA1_REPLY);
    expect(changes).toEqual([
      { foreground: LIGHT.foreground, background: LIGHT.background, palette: [] },
    ]);
    dispose();
  });

  test("stops waiting for a fence the terminal never answers", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose } = startTestWatcher(renderer, { fenceExpiryMs: 40 });

    renderer.deliver("\x1b[?997;1n");
    await waitForTestDebounce();
    renderer.deliver(...createTestColorReplies(DARK));
    renderer.deliver("\x1b[?997;2n");
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(1);

    await Bun.sleep(50);
    expect(renderer.writes).toHaveLength(2);
    renderer.deliver(...createTestColorReplies(LIGHT));
    expect(changes.map((colors) => colors.background)).toEqual([DARK.background, LIGHT.background]);
    dispose();
  });

  test("does not probe while the renderer is suspended", async () => {
    const renderer = createTestColorRenderer();
    renderer.controlState = RendererControlState.EXPLICIT_SUSPENDED;
    const { dispose, signals } = startTestWatcher(renderer);

    signals.emit("SIGWINCH");
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(0);
    expect(renderer.subscribers.size).toBe(0);
    dispose();
  });

  test("falls back to OpenTUI's palette probe when the renderer cannot write raw bytes", async () => {
    const renderer = createTestColorRenderer({ palette: createTestTerminalColors(DARK) });
    const { changes, dispose } = startTestWatcher(renderer, { write: null });

    renderer.deliver("\x1b[?997;1n");
    await Bun.sleep(30);
    expect(renderer.cacheClears).toBe(1);
    expect(renderer.probes).toBe(1);
    expect(changes).toEqual([createTestTerminalColors(DARK)]);
    dispose();
  });

  test("keeps probing after the palette fallback fails to clear its cache", async () => {
    const renderer = createTestColorRenderer({ palette: createTestTerminalColors(DARK) });
    const clearPaletteCache = renderer.clearPaletteCache;
    renderer.clearPaletteCache = () => {
      renderer.clearPaletteCache = clearPaletteCache;
      throw new Error("renderer is suspending");
    };
    const { changes, dispose } = startTestWatcher(renderer, { write: null });

    renderer.deliver("\x1b[?997;1n");
    await Bun.sleep(30);
    expect(renderer.probes).toBe(0);
    expect(changes).toEqual([]);

    renderer.deliver("\x1b[?997;1n");
    await Bun.sleep(30);
    expect(renderer.probes).toBe(1);
    expect(changes).toEqual([createTestTerminalColors(DARK)]);
    dispose();
  });

  test("probes when OpenTUI reports a theme mode without invalidating an in-flight probe", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose } = startTestWatcher(renderer);

    renderer.emitThemeMode();
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(1);

    renderer.emitThemeMode();
    await waitForTestDebounce();
    renderer.deliver(...createTestColorReplies(DARK), DA1_REPLY);
    expect(renderer.writes).toHaveLength(1);
    expect(changes).toEqual([createTestTerminalColors(DARK)]);

    dispose();
    renderer.emitThemeMode();
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(1);
  });

  test("probes once at mount when startup never learned the terminal colors", async () => {
    const renderer = createTestColorRenderer();
    const { changes, dispose } = startTestWatcher(renderer, { initial: undefined });

    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(1);
    renderer.deliver(...createTestColorReplies(DARK), DA1_REPLY);
    expect(changes).toEqual([createTestTerminalColors(DARK)]);
    dispose();
  });

  test("ignores unrelated input and compares reports by value", async () => {
    const renderer = createTestColorRenderer();
    const { dispose } = startTestWatcher(renderer);
    renderer.deliver("\x1b[A", `\x1b]11;${createTestRgbSpec(DARK.background)}\x07`);
    await waitForTestDebounce();
    expect(renderer.writes).toHaveLength(0);
    expect(renderer.consumed).toEqual([]);
    dispose();

    const colors = { foreground: "#ffffff", background: "#000000", palette: ["#111111"] };
    expect(sameTerminalColors(colors, { ...colors, palette: ["#111111"] })).toBe(true);
    expect(sameTerminalColors(colors, { ...colors, palette: ["#222222"] })).toBe(false);
    expect(sameTerminalColors(undefined, colors)).toBe(false);
  });

  test("writes raw bytes through the renderer's own writeOut when it has one", () => {
    const written: string[] = [];
    const renderer = {
      label: "renderer",
      writeOut(this: { label: string }, data: string) {
        written.push(`${this.label}:${data}`);
      },
    };
    rendererRawWriter(renderer)?.("\x1b[c");
    expect(written).toEqual(["renderer:\x1b[c"]);
    expect(rendererRawWriter({})).toBeUndefined();
  });
});
