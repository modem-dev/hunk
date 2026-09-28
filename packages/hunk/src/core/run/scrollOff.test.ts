import { describe, expect, test } from "bun:test";
import { DEFAULT_SCROLL_OFF, parseScrollOff, validateScrollOff } from "./scrollOff";

describe("scroll off", () => {
  test("accepts zero and bounded positive CLI values", () => {
    expect(parseScrollOff("0")).toBe(DEFAULT_SCROLL_OFF);
    expect(parseScrollOff("5")).toBe(5);
    expect(parseScrollOff("40")).toBe(40);
  });

  test("rejects malformed and out-of-range values", () => {
    for (const value of ["-1", "41", "1.5", "off"]) {
      expect(() => parseScrollOff(value)).toThrow(/scroll off/);
    }

    expect(() => validateScrollOff(Number.NaN)).toThrow(/scroll off/);
  });
});
