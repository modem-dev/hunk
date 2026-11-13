import { describe, expect, test } from "bun:test";
import {
  headerImageSize,
  isPreviewImagePath,
  previewDisplaySize,
  sniffPreviewImageMime,
} from "./imageSniff";

const bytes = (...values: Array<number | string>) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === "string"
        ? Array.from(value, (character) => character.charCodeAt(0))
        : [value],
    ),
  );

describe("image previews", () => {
  test("only image extensions are candidates", () => {
    expect(isPreviewImagePath("assets/logo.PNG")).toBe(true);
    expect(isPreviewImagePath("a/b.svg")).toBe(true);
    expect(isPreviewImagePath("a/b.pdf")).toBe(false);
    expect(isPreviewImagePath("png")).toBe(false);
    expect(isPreviewImagePath(".png")).toBe(false);
  });

  test("the type comes from the signature, never the path", () => {
    expect(sniffPreviewImageMime(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      "image/png",
    );
    expect(sniffPreviewImageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffPreviewImageMime(bytes("GIF89a", 1, 0, 1, 0))).toBe("image/gif");
    expect(sniffPreviewImageMime(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("image/webp");
    expect(sniffPreviewImageMime(bytes(0, 0, 0, 0x1c, "ftypavif"))).toBe("image/avif");
    expect(sniffPreviewImageMime(bytes('<?xml version="1.0"?>\n<svg xmlns="x"/>'))).toBe(
      "image/svg+xml",
    );
    // A PDF, an HTML page, and a script named like an image are not images.
    expect(sniffPreviewImageMime(bytes("%PDF-1.7"))).toBeUndefined();
    expect(sniffPreviewImageMime(bytes("<html><script>alert(1)</script>"))).toBeUndefined();
    expect(sniffPreviewImageMime(bytes("alert(1)//<svg>"))).toBeUndefined();
    expect(sniffPreviewImageMime(new Uint8Array())).toBeUndefined();
  });

  test("reads PNG and GIF dimensions from their headers", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    expect(headerImageSize(png, "image/png")).toEqual({ width: 640, height: 480 });
    expect(headerImageSize(bytes("GIF89a", 16, 0, 9, 0), "image/gif")).toEqual({
      width: 16,
      height: 9,
    });
    expect(headerImageSize(bytes(0xff, 0xd8), "image/jpeg")).toBeUndefined();
  });
});

describe("previewDisplaySize", () => {
  test("enlarges small images by a whole factor and shrinks large ones to fit", () => {
    expect(previewDisplaySize(16, 16)).toEqual({ width: 128, height: 128 });
    expect(previewDisplaySize(64, 32)).toEqual({ width: 448, height: 224 });
    expect(previewDisplaySize(400, 300)).toEqual({ width: 400, height: 300 });
    expect(previewDisplaySize(4000, 1000)).toEqual({ width: 460, height: 115 });
    expect(previewDisplaySize(0, 10)).toEqual({ width: 0, height: 0 });
  });
});
