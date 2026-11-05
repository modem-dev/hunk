import { describe, expect, test } from "bun:test";
import { createTestPng } from "../../../../../../../test/helpers/image-fixtures";
import {
  describeImageChange,
  describeImageSide,
  formatImageBytes,
  readImageFacts,
  type ImageFacts,
} from "./describe";

/** Build image facts with defaults for fields a test does not compare. */
function createTestImageFacts(overrides: Partial<ImageFacts>): ImageFacts {
  return { width: 10, height: 10, format: "PNG", bytes: 100, ...overrides };
}

describe("readImageFacts", () => {
  test("reads real dimensions and format from PNG bytes", () => {
    const png = createTestPng(24, 12, [40, 90, 220]);

    expect(readImageFacts(png)).toEqual({
      width: 24,
      height: 12,
      format: "PNG",
      bytes: png.length,
    });
  });

  test("explains Git LFS pointers and other undecodable bytes instead of throwing", () => {
    const pointer = new TextEncoder().encode(
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n",
    );

    expect(readImageFacts(pointer)).toEqual({
      error: "stored in Git LFS; only the pointer file is in the repository",
    });
    expect(readImageFacts(new TextEncoder().encode("not an image"))).toEqual({
      error: "not a decodable PNG, JPEG, GIF, or WebP image",
    });
  });
});

describe("image captions", () => {
  test("format byte sizes like a file manager", () => {
    expect([
      formatImageBytes(80),
      formatImageBytes(2048),
      formatImageBytes(41_000),
      formatImageBytes(5 * 1024 * 1024),
    ]).toEqual(["80 B", "2.0 KB", "40 KB", "5.0 MB"]);
  });

  test("describe one side", () => {
    expect(
      describeImageSide(createTestImageFacts({ width: 640, height: 480, bytes: 41_000 })),
    ).toBe("640×480 PNG · 40 KB");
  });

  test("summarize a resize with the size delta", () => {
    expect(
      describeImageChange(
        createTestImageFacts({ width: 24, height: 12, bytes: 80 }),
        createTestImageFacts({ width: 32, height: 20, bytes: 89 }),
      ),
    ).toBe("24×12 → 32×20 · 80 B → 89 B (+9 B)");
  });

  test("call out same-size edits, format changes, and shrinking files", () => {
    expect(
      describeImageChange(
        createTestImageFacts({ bytes: 3000 }),
        createTestImageFacts({ format: "WEBP", bytes: 1000 }),
      ),
    ).toBe("same size 10×10 · PNG → WEBP · 2.9 KB → 1000 B (−2.0 KB)");
  });
});
