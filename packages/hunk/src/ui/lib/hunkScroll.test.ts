import { describe, expect, test } from "bun:test";
import {
  computeHunkRevealScrollTop,
  computeLineAlignmentScrollTop,
  computeLineRevealScrollTop,
} from "./hunkScroll";

describe("computeHunkRevealScrollTop", () => {
  test("keeps a fitting hunk fully visible when the preferred padding would clip the end", () => {
    expect(
      computeHunkRevealScrollTop({
        hunkTop: 20,
        hunkHeight: 10,
        preferredTopPadding: 4,
        viewportHeight: 12,
      }),
    ).toBe(18);
  });

  test("preserves the preferred top padding when the full hunk still fits", () => {
    expect(
      computeHunkRevealScrollTop({
        hunkTop: 20,
        hunkHeight: 10,
        preferredTopPadding: 4,
        viewportHeight: 16,
      }),
    ).toBe(16);
  });

  test("biases toward the hunk top when the hunk is taller than the viewport", () => {
    expect(
      computeHunkRevealScrollTop({
        hunkTop: 40,
        hunkHeight: 18,
        preferredTopPadding: 5,
        viewportHeight: 10,
      }),
    ).toBe(35);
  });

  test("clamps negative tops and padding at the start of the content", () => {
    expect(
      computeHunkRevealScrollTop({
        hunkTop: -3,
        hunkHeight: 6,
        preferredTopPadding: 4,
        viewportHeight: 12,
      }),
    ).toBe(0);
  });

  test("falls back to the desired top when the viewport height is zero", () => {
    expect(
      computeHunkRevealScrollTop({
        hunkTop: 25,
        hunkHeight: 8,
        preferredTopPadding: 6,
        viewportHeight: 0,
      }),
    ).toBe(19);
  });
});

describe("computeLineAlignmentScrollTop", () => {
  test("aligns a rendered line to the top, center, and bottom", () => {
    const input = { lineTop: 20, lineHeight: 2, viewportHeight: 10 };
    expect(computeLineAlignmentScrollTop({ ...input, alignment: "top" })).toBe(20);
    expect(computeLineAlignmentScrollTop({ ...input, alignment: "center" })).toBe(16);
    expect(computeLineAlignmentScrollTop({ ...input, alignment: "bottom" })).toBe(12);
  });

  test("clamps alignment at the start and handles rows taller than the viewport", () => {
    expect(
      computeLineAlignmentScrollTop({
        alignment: "center",
        lineTop: 2,
        lineHeight: 1,
        viewportHeight: 20,
      }),
    ).toBe(0);
    expect(
      computeLineAlignmentScrollTop({
        alignment: "bottom",
        lineTop: 10,
        lineHeight: 20,
        viewportHeight: 8,
      }),
    ).toBe(22);
  });
});

describe("computeLineRevealScrollTop", () => {
  test("leaves the viewport alone when the line is already visible", () => {
    expect(
      computeLineRevealScrollTop({ lineTop: 12, lineHeight: 1, scrollTop: 10, viewportHeight: 20 }),
    ).toBe(10);
  });

  test("scrolls up just far enough to reach a line above the viewport", () => {
    expect(
      computeLineRevealScrollTop({ lineTop: 4, lineHeight: 1, scrollTop: 10, viewportHeight: 20 }),
    ).toBe(4);
  });

  test("scrolls down just far enough to reach a line below the viewport", () => {
    expect(
      computeLineRevealScrollTop({ lineTop: 40, lineHeight: 1, scrollTop: 10, viewportHeight: 20 }),
    ).toBe(21);
  });

  test("keeps a tall wrapped line's end on screen", () => {
    expect(
      computeLineRevealScrollTop({ lineTop: 28, lineHeight: 3, scrollTop: 10, viewportHeight: 20 }),
    ).toBe(11);
  });

  test("never scrolls above the top of the stream", () => {
    expect(
      computeLineRevealScrollTop({ lineTop: 0, lineHeight: 40, scrollTop: 5, viewportHeight: 20 }),
    ).toBe(0);
  });
});
