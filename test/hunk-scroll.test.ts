import { describe, expect, test } from "bun:test";
import { computeHunkRevealScrollTop } from "../src/ui/lib/hunkScroll";

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
