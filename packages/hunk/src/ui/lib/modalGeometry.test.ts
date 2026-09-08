import { describe, expect, test } from "bun:test";
import { resolveModalGeometry } from "./modalGeometry";

describe("resolveModalGeometry", () => {
  test("centers requested dimensions inside the terminal", () => {
    expect(
      resolveModalGeometry({ width: 40, height: 10, terminalWidth: 80, terminalHeight: 24 }),
    ).toEqual({ width: 40, height: 10, left: 20, top: 7 });
  });

  test("uses the real narrow and short viewport instead of an artificial minimum", () => {
    expect(
      resolveModalGeometry({ width: 72, height: 20, terminalWidth: 30, terminalHeight: 8 }),
    ).toEqual({ width: 28, height: 6, left: 1, top: 1 });
  });
});
