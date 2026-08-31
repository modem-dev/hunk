import { describe, expect, test } from "bun:test";
import { windowDialogLiteralText, windowDialogText } from "./extensionDialogGeometry";

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

describe("windowDialogLiteralText", () => {
  test("wraps copyable text without collapsing whitespace", () => {
    expect(windowDialogLiteralText(["  one  two", "    three"], 7, 4)).toEqual({
      lines: ["  one  ", "two", "    thr", "ee"],
      truncated: false,
    });
  });

  test("keeps meaningful literal text in a one-row window", () => {
    expect(windowDialogLiteralText(["one  two"], 5, 1)).toEqual({
      lines: ["one …"],
      truncated: true,
    });
  });
});
