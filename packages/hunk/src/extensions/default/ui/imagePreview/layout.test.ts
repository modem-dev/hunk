import { describe, expect, test } from "bun:test";
import { createTestPng } from "../../../../../../../test/helpers/image-fixtures";
import {
  imageRows,
  layoutImagePair,
  MAX_IMAGE_ROWS,
  SIDE_BY_SIDE_MIN_WIDTH,
  type ImagePainter,
  type ImageSideState,
} from "./layout";

const BLUE = createTestPng(24, 12, [40, 90, 220]);
const GREEN = createTestPng(32, 20, [40, 200, 90]);

/** Record which images each component row was asked to paint, without a renderer. */
function createTestPainter() {
  const painted: number[][] = [];
  const paint: ImagePainter = (images) => {
    painted.push(images.map((bytes) => bytes?.length ?? 0));
    return () => null;
  };
  return { paint, painted };
}

/** Wrap bytes as a loaded side. */
function loadedTestSide(bytes: Uint8Array): ImageSideState {
  return { kind: "loaded", bytes };
}

describe("imageRows", () => {
  test("uses one column per pixel and two pixels per row", () => {
    expect(imageRows({ width: 24, height: 12, format: "PNG", bytes: 1 }, 100)).toBe(6);
  });

  test("shrinks to the available width and caps tall images", () => {
    expect(imageRows({ width: 400, height: 200, format: "PNG", bytes: 1 }, 40)).toBe(10);
    expect(imageRows({ width: 10, height: 1000, format: "PNG", bytes: 1 }, 80)).toBe(
      MAX_IMAGE_ROWS,
    );
  });
});

describe("layoutImagePair", () => {
  test("places both sides next to each other in a wide section", () => {
    const { paint, painted } = createTestPainter();
    const rows = layoutImagePair(
      { before: loadedTestSide(BLUE), after: loadedTestSide(GREEN) },
      100,
      paint,
    );

    expect(rows.map((row) => row.id)).toEqual(["summary", "captions", "images"]);
    expect(rows[0]!.spans[0]!.text).toBe(
      `24×12 → 32×20 · ${BLUE.length} B → ${GREEN.length} B (+${GREEN.length - BLUE.length} B)`,
    );
    expect(rows[1]!.spans[0]!.text).toContain("Before · 24×12 PNG");
    expect(rows[1]!.spans[0]!.text).toContain("After · 32×20 PNG");
    expect(rows[2]!.component!.height).toBe(
      imageRows({ width: 32, height: 20, format: "PNG", bytes: 1 }, 48),
    );
    expect(painted).toEqual([[BLUE.length, GREEN.length]]);
  });

  test("stacks the sides in a narrow section", () => {
    const { paint, painted } = createTestPainter();
    const rows = layoutImagePair(
      { before: loadedTestSide(BLUE), after: loadedTestSide(GREEN) },
      SIDE_BY_SIDE_MIN_WIDTH - 1,
      paint,
    );

    expect(rows.map((row) => row.id)).toEqual([
      "summary",
      "before-caption",
      "before-image",
      "after-caption",
      "after-image",
    ]);
    expect(painted).toEqual([[BLUE.length], [GREEN.length]]);
  });

  test("shows only the existing side of an added image, without a summary", () => {
    const { paint } = createTestPainter();
    const rows = layoutImagePair(
      { before: { kind: "absent" }, after: loadedTestSide(GREEN) },
      100,
      paint,
    );

    expect(rows.map((row) => row.id)).toEqual(["before-caption", "after-caption", "after-image"]);
    expect(rows[0]!.spans[0]!.text).toBe("Before · none, the image was added");
  });

  test("captions unavailable and undecodable sides in the removed tone instead of drawing them", () => {
    const { paint, painted } = createTestPainter();
    const rows = layoutImagePair(
      {
        before: { kind: "failed", reason: "this review source cannot supply the image" },
        after: loadedTestSide(new TextEncoder().encode("not an image")),
      },
      100,
      paint,
    );

    expect(rows.map((row) => [row.spans[0]!.text, row.spans[0]!.tone])).toEqual([
      ["Before · can't show: this review source cannot supply the image", "removed"],
      ["After · can't show: not a decodable PNG, JPEG, GIF, or WebP image", "removed"],
    ]);
    expect(painted).toEqual([]);
  });

  test("keeps every row's fallback text within one terminal line", () => {
    const { paint } = createTestPainter();
    const rows = layoutImagePair(
      { before: loadedTestSide(BLUE), after: loadedTestSide(GREEN) },
      100,
      paint,
    );

    expect(rows.every((row) => row.spans.every((span) => !span.text.includes("\n")))).toBe(true);
  });
});
