import { describe, expect, test } from "bun:test";
import { verticalGradient } from "../raster/paint";
import { createPixmap, fillAll } from "../raster/pixmap";
import { fillRoundRect } from "../raster/shapes";
import { blocksBackend } from "./blocks";
import type { CellGeometry } from "./types";

const geometry: CellGeometry = { cols: 4, rows: 2, cellWidth: 8, cellHeight: 16 };

/** Renders a pixmap and returns the escape stream. */
function render(style: "half" | "quadrant", paint: (pm: ReturnType<typeof createPixmap>) => void) {
  const pm = createPixmap(geometry.cols * geometry.cellWidth, geometry.rows * geometry.cellHeight);
  paint(pm);
  const output = blocksBackend(style).render(pm, geometry);
  if (output.kind !== "terminal") throw new Error("expected terminal output");
  return output.data;
}

/** Counts distinct truecolor SGR values in a stream. */
function distinctColors(stream: string): number {
  return new Set(stream.match(/\[[34]8;2;\d+;\d+;\d+m/g) ?? []).size;
}

describe("half-block rendering", () => {
  test("emits one glyph per cell", () => {
    const out = render("half", (pm) => fillAll(pm, [10, 20, 30, 255]));
    expect([...out].filter((c) => c === "▀")).toHaveLength(geometry.cols * geometry.rows);
  });

  test("positions each row absolutely so a repaint does not depend on cursor state", () => {
    const out = render("half", (pm) => fillAll(pm, [10, 20, 30, 255]));
    expect(out).toContain("[1;1H");
    expect(out).toContain("[2;1H");
  });

  test("collapses a flat fill to a single color pair", () => {
    const out = render("half", (pm) => fillAll(pm, [10, 20, 30, 255]));
    expect(distinctColors(out)).toBe(2);
  });

  test("splits a vertical gradient into distinct top and bottom colors", () => {
    const out = render("half", (pm) =>
      fillRoundRect(
        pm,
        { x: 0, y: 0, width: pm.width, height: pm.height },
        0,
        verticalGradient("#000000", "#ffffff"),
      ),
    );
    expect(distinctColors(out)).toBeGreaterThan(2);
  });

  test("resets styling at the end so later output is unaffected", () => {
    expect(render("half", (pm) => fillAll(pm, [1, 2, 3, 255]))).toEndWith("[0m");
  });
});

describe("quadrant rendering", () => {
  test("picks a glyph matching which quadrants are brighter", () => {
    // Light the left half only; the renderer should choose the left-half glyph.
    const out = render("quadrant", (pm) => {
      fillAll(pm, [0, 0, 0, 255]);
      fillRoundRect(pm, { x: 0, y: 0, width: pm.width / 2, height: pm.height }, 0, () => [
        255, 255, 255, 255,
      ]);
    });
    expect(out).toContain("▌");
  });

  test("uses a solid block where a cell is uniform", () => {
    expect(render("quadrant", (pm) => fillAll(pm, [50, 50, 50, 255]))).toContain("█");
  });

  test("never exceeds two colors per cell, whatever the content", () => {
    // Four distinct quadrant colors in a single cell still have to collapse to
    // one foreground and one background. Rendering exactly one cell keeps the
    // assertion about that cell rather than about the stream around it.
    const single: CellGeometry = { cols: 1, rows: 1, cellWidth: 8, cellHeight: 16 };
    const pm = createPixmap(8, 16);
    fillRoundRect(pm, { x: 0, y: 0, width: 4, height: 8 }, 0, () => [255, 0, 0, 255]);
    fillRoundRect(pm, { x: 4, y: 0, width: 4, height: 8 }, 0, () => [0, 255, 0, 255]);
    fillRoundRect(pm, { x: 0, y: 8, width: 4, height: 8 }, 0, () => [0, 0, 255, 255]);
    fillRoundRect(pm, { x: 4, y: 8, width: 4, height: 8 }, 0, () => [255, 255, 0, 255]);

    const output = blocksBackend("quadrant").render(pm, single);
    if (output.kind !== "terminal") throw new Error("expected terminal output");
    expect((output.data.match(/\[38;2;/g) ?? []).length).toBe(1);
    expect((output.data.match(/\[48;2;/g) ?? []).length).toBe(1);
  });
});
