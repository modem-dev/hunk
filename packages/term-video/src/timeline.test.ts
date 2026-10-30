import { describe, expect, test } from "bun:test";
import { encodeArgs, frameTimes } from "./timeline.mjs";

describe("frameTimes", () => {
  test("samples from zero at the frame rate and stops before the duration", () => {
    expect(frameTimes(0.1, 30)).toEqual([0, 1 / 30, 2 / 30]);
  });

  test("rounds fractional frame counts to the nearest whole frame", () => {
    expect(frameTimes(49.04, 30)).toHaveLength(1471);
  });
});

describe("encodeArgs", () => {
  test("reads the numbered sequence at its own rate and writes a faststart yuv420p mp4", () => {
    const args = encodeArgs({ framesPattern: "out/f%05d.png", fps: 30, output: "promo.mp4" });

    expect(args.slice(args.indexOf("-framerate"), args.indexOf("-framerate") + 4)).toEqual([
      "-framerate",
      "30",
      "-i",
      "out/f%05d.png",
    ]);
    expect(args).toContain("format=yuv420p");
    expect(args).toContain("+faststart");
    expect(args.at(-1)).toBe("promo.mp4");
  });
});
