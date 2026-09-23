import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WHEEL_SCROLL_LINES,
  parseWheelScrollLines,
  validateWheelScrollLines,
} from "./wheelScrollLines";

describe("wheel scroll lines", () => {
  test("accepts auto and bounded integer CLI values", () => {
    expect(parseWheelScrollLines("auto")).toBe(DEFAULT_WHEEL_SCROLL_LINES);
    expect(parseWheelScrollLines("1")).toBe(1);
    expect(parseWheelScrollLines("10")).toBe(10);
  });

  test("rejects malformed and out-of-range values", () => {
    for (const value of ["0", "11", "1.5", "fast"]) {
      expect(() => parseWheelScrollLines(value)).toThrow(/wheel scroll lines/);
    }

    expect(() => validateWheelScrollLines(Number.NaN)).toThrow(/wheel scroll lines/);
  });
});
