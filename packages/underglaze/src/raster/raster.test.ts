import { describe, expect, test } from "bun:test";
import { linearGradient, mix, parseColor, solid, verticalGradient, withAlpha } from "./paint";
import { encodeDeflatedRgba, encodePng } from "./png";
import { blendPixel, createPixmap, downscale, fillAll, getPixel } from "./pixmap";
import { dropShadow } from "./shadow";
import { fillRoundRect, roundRectCoverage, roundRectDistance, strokeRoundRect } from "./shapes";

describe("parseColor", () => {
  test("reads every hex length, defaulting alpha to opaque", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255, 255]);
    expect(parseColor("#ff0000")).toEqual([255, 0, 0, 255]);
    expect(parseColor("#00ff0080")).toEqual([0, 255, 0, 128]);
    expect(parseColor("#f00f")).toEqual([255, 0, 0, 255]);
  });

  test("passes an already-parsed color through", () => {
    expect(parseColor([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  test("rejects nonsense rather than silently rendering black", () => {
    expect(() => parseColor("rebeccapurple")).toThrow(/unrecognized color/);
  });
});

describe("paints", () => {
  test("mixes toward the destination color", () => {
    expect(mix([0, 0, 0, 255], [100, 200, 50, 255], 0.5)).toEqual([50, 100, 25, 255]);
  });

  test("scales alpha without touching the color channels", () => {
    expect(withAlpha("#ffffff", 0.5)).toEqual([255, 255, 255, 127.5]);
  });

  test("returns one color everywhere for a solid paint", () => {
    const paint = solid("#123456");
    expect(paint(0, 0)).toEqual(paint(1, 1));
  });

  test("runs a vertical gradient top to bottom by default", () => {
    const paint = verticalGradient("#000000", "#ffffff");
    expect(paint(0.5, 0)[0]).toBeLessThan(paint(0.5, 1)[0]);
  });

  test("runs a 90 degree gradient left to right", () => {
    const paint = linearGradient(
      [
        { offset: 0, color: "#000000" },
        { offset: 1, color: "#ffffff" },
      ],
      90,
    );
    expect(paint(0, 0.5)[0]).toBeLessThan(paint(1, 0.5)[0]);
  });

  test("holds the end colors outside the outermost stops", () => {
    const paint = linearGradient([
      { offset: 0.4, color: "#000000" },
      { offset: 0.6, color: "#ffffff" },
    ]);
    expect(paint(0.5, 0)).toEqual([0, 0, 0, 255]);
    expect(paint(0.5, 1)).toEqual([255, 255, 255, 255]);
  });
});

describe("rounded rectangle geometry", () => {
  const rect = { x: 10, y: 10, width: 40, height: 20 };

  test("reports negative distance inside and positive outside", () => {
    expect(roundRectDistance(30, 20, rect, 5)).toBeLessThan(0);
    expect(roundRectDistance(0, 0, rect, 5)).toBeGreaterThan(0);
  });

  test("gives full coverage well inside and none well outside", () => {
    expect(roundRectCoverage(30, 20, rect, 5)).toBe(1);
    expect(roundRectCoverage(100, 100, rect, 5)).toBe(0);
  });

  test("cuts the corner when a radius is applied", () => {
    // The extreme corner pixel is inside a square rect but outside a rounded one.
    expect(roundRectCoverage(10, 10, rect, 0)).toBeGreaterThan(0);
    expect(roundRectCoverage(10, 10, rect, 10)).toBe(0);
  });

  test("antialiases the edge instead of snapping to whole pixels", () => {
    const edge = roundRectCoverage(10, 20, rect, 0);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });

  test("clamps a radius larger than the shape to a capsule", () => {
    expect(roundRectCoverage(30, 20, rect, 1000)).toBe(1);
  });
});

describe("pixmap", () => {
  test("composites alpha rather than replacing the destination", () => {
    const pm = createPixmap(1, 1);
    fillAll(pm, [0, 0, 0, 255]);
    blendPixel(pm, 0, 0, [255, 255, 255, 128]);
    const [r] = getPixel(pm, 0, 0);
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(160);
  });

  test("scales coverage into the blend for soft edges", () => {
    const pm = createPixmap(1, 1);
    fillAll(pm, [0, 0, 0, 255]);
    blendPixel(pm, 0, 0, [255, 255, 255, 255], 0.25);
    expect(getPixel(pm, 0, 0)[0]).toBeLessThan(100);
  });

  test("drops writes outside the buffer instead of wrapping to another row", () => {
    const pm = createPixmap(2, 2);
    expect(() => blendPixel(pm, 99, 99, [255, 0, 0, 255])).not.toThrow();
    expect(getPixel(pm, 0, 0)[3]).toBe(0);
  });

  test("averages blocks when downscaling", () => {
    const pm = createPixmap(2, 2);
    fillAll(pm, [100, 100, 100, 255]);
    const small = downscale(pm, 2);
    expect(small.width).toBe(1);
    expect(getPixel(small, 0, 0)[0]).toBeCloseTo(100, 0);
  });
});

describe("shadow", () => {
  test("spreads darkness beyond the shape's own bounds", () => {
    const pm = createPixmap(60, 60);
    fillAll(pm, [255, 255, 255, 255]);
    dropShadow(pm, { x: 20, y: 20, width: 20, height: 20 }, 4, { dy: 0, blur: 5, opacity: 1 });
    // Just outside the shape the shadow is present but not fully opaque.
    const outside = getPixel(pm, 17, 30)[0];
    expect(outside).toBeLessThan(255);
    expect(outside).toBeGreaterThan(0);
  });

  test("falls off with distance rather than ending abruptly", () => {
    const pm = createPixmap(80, 80);
    fillAll(pm, [255, 255, 255, 255]);
    dropShadow(pm, { x: 30, y: 30, width: 20, height: 20 }, 4, { dy: 0, blur: 6, opacity: 1 });
    const near = getPixel(pm, 27, 40)[0];
    const far = getPixel(pm, 20, 40)[0];
    expect(near).toBeLessThan(far);
  });
});

describe("png encoding", () => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("writes a valid signature and header dimensions", () => {
    const pm = createPixmap(7, 3);
    const png = encodePng(pm);
    expect([...png.subarray(0, 8)]).toEqual(signature);
    // IHDR payload starts at byte 16: width then height, big endian.
    expect(png.readUInt32BE(16)).toBe(7);
    expect(png.readUInt32BE(20)).toBe(3);
  });

  test("ends with an IEND chunk", () => {
    const png = encodePng(createPixmap(4, 4));
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  test("beats raw deflate on gradients, which is why filtering is worth carrying", () => {
    const pm = createPixmap(256, 256);
    const paint = verticalGradient("#102040", "#e0d0c0");
    fillRoundRect(pm, { x: 0, y: 0, width: 256, height: 256 }, 0, paint);
    expect(encodePng(pm).length).toBeLessThan(encodeDeflatedRgba(pm).length / 2);
  });

  test("compresses a flat fill to a small fraction of the raw bytes", () => {
    const pm = createPixmap(128, 128);
    fillAll(pm, [20, 30, 40, 255]);
    expect(encodePng(pm).length).toBeLessThan(128 * 128 * 4 * 0.01);
  });
});

describe("stroke", () => {
  test("keeps the line inside the declared bounds", () => {
    const pm = createPixmap(40, 40);
    strokeRoundRect(pm, { x: 10, y: 10, width: 20, height: 20 }, 4, 2, solid("#ff0000"));
    // Outside the rect nothing was drawn; on the edge it was.
    expect(getPixel(pm, 5, 20)[3]).toBe(0);
    expect(getPixel(pm, 11, 20)[3]).toBeGreaterThan(0);
    // The interior stays empty, since this is a stroke and not a fill.
    expect(getPixel(pm, 20, 20)[3]).toBe(0);
  });
});
