import { describe, expect, test } from "bun:test";
import { projectTerminalFocus } from "./stageGeometry.mjs";

describe("projectTerminalFocus", () => {
  test("projects camera and highlight geometry through a full-height capture", () => {
    const projection = projectTerminalFocus({
      camera: { x: 0.5, y: 0.5, scale: 1 },
      highlight: { x: 0.1, y: 0.2, width: 0.7, height: 0.3 },
      sourceWidth: 1_560,
      sourceHeight: 892,
      viewportWidth: 1_560,
      viewportHeight: 892,
    });

    expect(projection).toEqual({
      translateX: 0,
      translateY: 0,
      scale: 1,
      highlight: { x: 156, y: 178.4, width: 1_092, height: 267.59999999999997 },
    });
  });

  test("uses an auto-trimmed capture's height instead of the filler height", () => {
    const projection = projectTerminalFocus({
      camera: { x: 0.5, y: 0.8, scale: 2 },
      highlight: { x: 0.1, y: 0.8, width: 0.4, height: 0.1 },
      sourceWidth: 1_560,
      sourceHeight: 500,
      viewportWidth: 1_560,
      viewportHeight: 892,
    });

    expect(projection.translateX).toBe(-780);
    expect(projection.translateY).toBe(-108);
    expect(projection.highlight).toEqual({
      x: -468,
      y: 692,
      width: 1_248,
      height: 100,
    });
  });

  test("keeps captures shorter than the viewport aligned above sampled filler", () => {
    const projection = projectTerminalFocus({
      camera: null,
      highlight: null,
      sourceWidth: 1_560,
      sourceHeight: 400,
      viewportWidth: 1_560,
      viewportHeight: 892,
    });

    expect(projection).toMatchObject({ translateX: 0, translateY: 0, highlight: null });
  });
});
