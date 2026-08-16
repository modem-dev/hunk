import { describe, expect, test } from "bun:test";
import { blocksBackend } from "../backend/blocks";
import { imageBackend } from "../backend/image";
import { kittyBackend } from "../backend/kitty";
import { detectCapability } from "../capability/detect";
import { verticalGradient } from "../raster/paint";
import { getPixel } from "../raster/pixmap";
import { autoBackend, createSurface, type Surface } from "./surface";

const ESC = String.fromCharCode(0x1b);
const noMultiplexer = detectCapability({ KITTY_WINDOW_ID: "1" });

/** Builds the same scene every backend is asked to render. */
function scene(): Surface {
  const surface = createSurface({ cols: 40, rows: 12, background: "#14151a" });
  surface.panel(
    { x: 2, y: 1, width: 36, height: 9 },
    {
      radius: 12,
      fill: verticalGradient("#2c2f3e", "#3c4052"),
      border: { color: "#78809f" },
      shadow: { dy: 3, blur: 5 },
      bevel: "#98a0c8",
    },
  );
  surface.pill({ x: 4, y: 7, width: 8, height: 1 }, { fill: "#d25a5a" });
  surface.meter({ x: 4, y: 4, width: 30, height: 1 }, 0.62);
  return surface;
}

describe("cell to pixel mapping", () => {
  test("scales cell coordinates by the cell geometry", () => {
    const surface = createSurface({ cols: 10, rows: 4, cellWidth: 8, cellHeight: 17 });
    expect(surface.toPixels({ x: 2, y: 1, width: 3, height: 2 })).toEqual({
      x: 16,
      y: 17,
      width: 24,
      height: 34,
    });
  });

  test("accepts fractional cells for sub-cell placement", () => {
    const surface = createSurface({ cols: 10, rows: 4, cellWidth: 8, cellHeight: 16 });
    expect(surface.toPixels({ x: 0.5, y: 0.25, width: 1, height: 1 }).x).toBe(4);
  });

  test("sizes its pixel buffer to the full grid", () => {
    const surface = createSurface({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 17 });
    const png = surface.toPng();
    expect(png.readUInt32BE(16)).toBe(640);
    expect(png.readUInt32BE(20)).toBe(408);
  });
});

describe("one scene, three backends", () => {
  test("renders to kitty escape sequences", () => {
    const output = scene().render(kittyBackend({ capability: noMultiplexer }));
    expect(output.kind).toBe("terminal");
    if (output.kind !== "terminal") return;
    expect(output.data).toContain(`${ESC}_G`);
    // Chrome is placed beneath the text layer.
    expect(output.data).toContain("z=-1");
    // And sized to the full cell grid it was drawn for.
    expect(output.data).toContain("c=40,r=12");
  });

  test("renders to block glyphs with no graphics sequences at all", () => {
    const output = scene().render(blocksBackend("half"));
    expect(output.kind).toBe("terminal");
    if (output.kind !== "terminal") return;
    expect(output.data).not.toContain(`${ESC}_G`);
    expect(output.data).toContain("▀");
    expect(output.data).toContain("[38;2;");
  });

  test("renders to a PNG buffer for snapshots", () => {
    const output = scene().render(imageBackend());
    expect(output.kind).toBe("image");
    if (output.kind !== "image") return;
    expect([...output.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("produces identical pixels regardless of which backend consumes them", () => {
    // The drawing layer is backend-independent: two surfaces built the same way
    // must serialize to byte-identical images.
    expect(scene().toPng().equals(scene().toPng())).toBe(true);
  });
});

describe("drawing", () => {
  test("paints the background before anything else", () => {
    const surface = createSurface({ cols: 4, rows: 2, background: "#ff0000" });
    surface.draw((pm) => {
      expect(getPixel(pm, 0, 0)).toEqual([255, 0, 0, 255]);
    });
  });

  test("leaves the surface transparent when no background is given", () => {
    createSurface({ cols: 4, rows: 2 }).draw((pm) => {
      expect(getPixel(pm, 0, 0)[3]).toBe(0);
    });
  });

  test("fills a meter proportionally to its value", () => {
    const read = (value: number) => {
      const surface = createSurface({ cols: 20, rows: 1, cellWidth: 8, cellHeight: 16 });
      surface.meter({ x: 0, y: 0, width: 20, height: 1 }, value);
      let lit = 0;
      surface.draw((pm) => {
        for (let x = 0; x < pm.width; x++) if (getPixel(pm, x, 8)[1] > 120) lit++;
      });
      return lit;
    };
    expect(read(0)).toBe(0);
    expect(read(1)).toBeGreaterThan(read(0.5));
    expect(read(0.5)).toBeGreaterThan(0);
  });

  test("clamps meter values outside 0 to 1", () => {
    const surface = createSurface({ cols: 10, rows: 1 });
    expect(() => surface.meter({ x: 0, y: 0, width: 10, height: 1 }, 5)).not.toThrow();
    expect(() => surface.meter({ x: 0, y: 0, width: 10, height: 1 }, -2)).not.toThrow();
  });

  test("chains draw calls", () => {
    const surface = createSurface({ cols: 10, rows: 4 });
    expect(surface.rect({ x: 0, y: 0, width: 1, height: 1 }, "#fff")).toBe(surface);
  });
});

describe("backend selection", () => {
  test("uses graphics only for a terminal confirmed to support them", () => {
    expect(autoBackend(detectCapability({ KITTY_WINDOW_ID: "1" })).name).toBe("kitty");
  });

  test("falls back to blocks for unknown terminals rather than risking garbage output", () => {
    expect(autoBackend(detectCapability({ TERM: "xterm-256color" })).name).toBe("blocks:half");
    expect(autoBackend(detectCapability({ WT_SESSION: "x" })).name).toBe("blocks:half");
  });

  test("refuses to write image bytes to a terminal", () => {
    expect(() => scene().toTerminal(imageBackend())).toThrow(/renders images/);
  });
});
