import { describe, expect, test } from "bun:test";
import type { TerminalCapabilities } from "@opentui/core";
import { verticalGradient } from "../raster/paint";
import {
  chromeIsWorthwhile,
  fromOpenTuiCapabilities,
  renderChromeLayer,
  toImageSource,
} from "./adapter";
import { createSurface } from "../scene/surface";
import { imageBackend } from "../backend/image";

/** Minimal capability record; only the fields the adapter reads matter. */
function withCaps(overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    kitty_graphics: false,
    sixel: false,
    rgb: true,
    multiplexer: "none",
    ...overrides,
  } as TerminalCapabilities;
}

describe("fromOpenTuiCapabilities", () => {
  test("trusts OpenTUI's runtime probe instead of guessing from the environment", () => {
    const cap = fromOpenTuiCapabilities(withCaps({ kitty_graphics: true }));
    expect(cap.graphics).toBe("kitty");
    expect(cap.terminal).toBe("opentui");
  });

  test("reports no graphics when the probe says so", () => {
    expect(fromOpenTuiCapabilities(withCaps({ kitty_graphics: false })).graphics).toBe("none");
  });

  test("carries the multiplexer through", () => {
    const cap = fromOpenTuiCapabilities(withCaps({ multiplexer: "tmux" } as never));
    expect(cap.multiplexer).toBe("tmux");
    expect(cap.needsPassthrough).toBe(true);
  });

  test("still cannot know the magnification filter, because no terminal reports it", () => {
    expect(fromOpenTuiCapabilities(withCaps({ kitty_graphics: true })).magnification).toBe(
      "unknown",
    );
  });
});

describe("chromeIsWorthwhile", () => {
  test("accepts either pixel protocol", () => {
    expect(chromeIsWorthwhile(withCaps({ kitty_graphics: true }))).toBe(true);
    expect(chromeIsWorthwhile(withCaps({ sixel: true }))).toBe(true);
  });

  test("declines when only block glyphs are available", () => {
    // Two colors per cell is exactly what chrome cannot survive.
    expect(chromeIsWorthwhile(withCaps({ kitty_graphics: false, sixel: false }))).toBe(false);
  });

  test("declines before capabilities are known", () => {
    expect(chromeIsWorthwhile(null)).toBe(false);
  });
});

describe("toImageSource", () => {
  test("produces PNG bytes, which is what ImageRenderable accepts", () => {
    const surface = createSurface({ cols: 8, rows: 2, backend: imageBackend() });
    const bytes = toImageSource(surface);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("renderChromeLayer", () => {
  test("draws at the requested grid size", () => {
    const layer = renderChromeLayer({ cols: 40, rows: 10, cellWidth: 8, cellHeight: 16 }, (s) => {
      s.panel(
        { x: 1, y: 1, width: 20, height: 5 },
        { radius: 8, fill: verticalGradient("#333", "#555") },
      );
    });
    expect(layer.cols).toBe(40);
    expect(layer.rows).toBe(10);
    const png = Buffer.from(layer.source);
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(160);
  });

  test("is deterministic, so a caller can cache on size alone", () => {
    const draw = (s: Parameters<Parameters<typeof renderChromeLayer>[1]>[0]) =>
      s.panel({ x: 0, y: 0, width: 4, height: 2 }, { radius: 4, fill: "#123456" });
    const a = renderChromeLayer({ cols: 10, rows: 4 }, draw);
    const b = renderChromeLayer({ cols: 10, rows: 4 }, draw);
    expect(Buffer.from(a.source).equals(Buffer.from(b.source))).toBe(true);
  });
});
