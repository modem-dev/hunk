import { describe, expect, test } from "bun:test";
import { solid } from "../raster/paint";
import { getPixel } from "../raster/pixmap";
import { fillRoundRect } from "../raster/shapes";
import { AtlasBuilder, atlasOccupancy, spriteRect, spriteSource } from "./atlas";

/** Fills a sprite's whole rectangle with one color, for locating it afterwards. */
const fillWith =
  (color: string) =>
  (
    pm: Parameters<typeof fillRoundRect>[0],
    rect: { x: number; y: number; width: number; height: number },
  ) =>
    fillRoundRect(pm, rect, 0, solid(color));

describe("packing", () => {
  test("places every declared sprite", () => {
    const atlas = new AtlasBuilder()
      .add("a", 20, 10, fillWith("#ff0000"))
      .add("b", 30, 10, fillWith("#00ff00"))
      .add("c", 10, 10, fillWith("#0000ff"))
      .bake();
    expect(atlas.sprites.size).toBe(3);
    for (const name of ["a", "b", "c"]) expect(atlas.sprites.has(name)).toBe(true);
  });

  test("gives sprites non-overlapping rectangles", () => {
    const atlas = new AtlasBuilder({ padding: 1 })
      .add("a", 20, 10, fillWith("#f00"))
      .add("b", 30, 14, fillWith("#0f0"))
      .add("c", 12, 22, fillWith("#00f"))
      .add("d", 40, 8, fillWith("#ff0"))
      .bake();
    const rects = [...atlas.sprites.values()];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const disjoint =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  test("keeps every sprite inside the baked pixmap", () => {
    const atlas = new AtlasBuilder({ maxWidth: 64 })
      .add("a", 40, 10, fillWith("#f00"))
      .add("b", 40, 10, fillWith("#0f0"))
      .add("c", 40, 10, fillWith("#00f"))
      .bake();
    for (const sprite of atlas.sprites.values()) {
      expect(sprite.x + sprite.width).toBeLessThanOrEqual(atlas.pixmap.width);
      expect(sprite.y + sprite.height).toBeLessThanOrEqual(atlas.pixmap.height);
    }
  });

  test("wraps to a new shelf rather than exceeding the width limit", () => {
    const atlas = new AtlasBuilder({ maxWidth: 64 })
      .add("a", 40, 10, fillWith("#f00"))
      .add("b", 40, 10, fillWith("#0f0"))
      .bake();
    expect(atlas.pixmap.width).toBeLessThanOrEqual(64);
    const a = spriteRect(atlas, "a");
    const b = spriteRect(atlas, "b");
    expect(a.y).not.toBe(b.y);
  });

  test("draws each sprite into its own rectangle", () => {
    const atlas = new AtlasBuilder({ padding: 2 })
      .add("red", 20, 20, fillWith("#ff0000"))
      .add("green", 20, 20, fillWith("#00ff00"))
      .bake();
    const red = spriteRect(atlas, "red");
    const green = spriteRect(atlas, "green");
    expect(getPixel(atlas.pixmap, red.x + 10, red.y + 10)).toEqual([255, 0, 0, 255]);
    expect(getPixel(atlas.pixmap, green.x + 10, green.y + 10)).toEqual([0, 255, 0, 255]);
  });

  test("leaves padding transparent so scaling cannot bleed a neighbour in", () => {
    const atlas = new AtlasBuilder({ padding: 2 })
      .add("a", 10, 10, fillWith("#ff0000"))
      .add("b", 10, 10, fillWith("#00ff00"))
      .bake();
    // The top-left padding gutter belongs to no sprite.
    expect(getPixel(atlas.pixmap, 0, 0)[3]).toBe(0);
  });

  test("orders tall sprites first so shelves hold similar heights", () => {
    const atlas = new AtlasBuilder({ padding: 0, maxWidth: 1000 })
      .add("short", 10, 5, fillWith("#f00"))
      .add("tall", 10, 50, fillWith("#0f0"))
      .bake();
    expect(spriteRect(atlas, "tall").x).toBeLessThan(spriteRect(atlas, "short").x);
  });
});

describe("lookup", () => {
  test("returns source rectangle keys ready for a placement", () => {
    const atlas = new AtlasBuilder({ padding: 0 }).add("chip", 24, 12, fillWith("#f00")).bake();
    expect(spriteSource(atlas, "chip")).toEqual({ srcX: 0, srcY: 0, srcW: 24, srcH: 12 });
  });

  test("fails loudly on an unknown sprite rather than drawing the wrong rectangle", () => {
    const atlas = new AtlasBuilder().add("a", 4, 4, fillWith("#f00")).bake();
    expect(() => spriteRect(atlas, "nope")).toThrow(/unknown sprite/);
  });
});

describe("validation", () => {
  test("rejects duplicate names, since the name is the lookup key", () => {
    const builder = new AtlasBuilder().add("a", 4, 4, fillWith("#f00"));
    expect(() => builder.add("a", 8, 8, fillWith("#0f0"))).toThrow(/duplicate/);
  });

  test("rejects empty sprites", () => {
    expect(() => new AtlasBuilder().add("a", 0, 4, fillWith("#f00"))).toThrow(/non-empty/);
  });

  test("rejects a sprite wider than the atlas can ever be", () => {
    expect(() => new AtlasBuilder({ maxWidth: 32 }).add("a", 64, 4, fillWith("#f00"))).toThrow(
      /over the 32px/,
    );
  });

  test("refuses to bake nothing", () => {
    expect(() => new AtlasBuilder().bake()).toThrow(/empty atlas/);
  });
});

describe("atlasOccupancy", () => {
  test("reports how much of the atlas the sprites actually cover", () => {
    const atlas = new AtlasBuilder({ padding: 0 })
      .add("a", 10, 10, fillWith("#f00"))
      .add("b", 10, 10, fillWith("#0f0"))
      .bake();
    expect(atlasOccupancy(atlas)).toBeGreaterThan(0.9);
  });
});
