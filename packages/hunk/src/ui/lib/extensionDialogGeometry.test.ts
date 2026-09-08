import { describe, expect, test } from "bun:test";
import { windowDialogText } from "./extensionDialogGeometry";

describe("windowDialogText", () => {
  test("wraps prose within the available terminal-cell rows", () => {
    expect(windowDialogText(["one two three"], 7, 3)).toEqual({
      lines: ["one two", "three"],
      truncated: false,
    });
  });

  test("pins an overflow marker to the final allocated row", () => {
    expect(windowDialogText(["one two three four"], 7, 2)).toEqual({
      lines: ["one two", "…"],
      truncated: true,
    });
    expect(windowDialogText(["overflow"], 3, 0)).toEqual({ lines: [], truncated: true });
  });
});
