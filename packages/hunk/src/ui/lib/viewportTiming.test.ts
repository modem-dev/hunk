import { describe, expect, test } from "bun:test";
import { estimateInitialRenderViewportHeight, resolveRenderViewportHeight } from "./viewportTiming";

describe("estimateInitialRenderViewportHeight", () => {
  test("subtracts the pane's screen top from the renderer height", () => {
    expect(estimateInitialRenderViewportHeight(80, 2)).toBe(78);
  });

  test("never returns an empty window while geometry is still unknown", () => {
    expect(estimateInitialRenderViewportHeight(0, 0)).toBe(1);
  });

  test("does not include a bottom pane in the review viewport estimate", () => {
    expect(estimateInitialRenderViewportHeight(100, 1, 5)).toBe(5);
  });
});

describe("resolveRenderViewportHeight", () => {
  test("falls back to the estimate while the scrollbox height is still 0", () => {
    expect(resolveRenderViewportHeight(0, 48)).toBe(48);
  });

  test("keeps the measured scrollbox height once it is available", () => {
    expect(resolveRenderViewportHeight(36, 48)).toBe(36);
  });
});
