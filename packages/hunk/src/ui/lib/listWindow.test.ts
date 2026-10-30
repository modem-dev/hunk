import { describe, expect, test } from "bun:test";
import { listWindowStart } from "./listWindow";

describe("listWindowStart", () => {
  test("shows the whole list when it fits", () => {
    expect(listWindowStart(0, 3, 5)).toBe(0);
    expect(listWindowStart(2, 3, 5)).toBe(0);
  });

  test("centers the selection once the list scrolls", () => {
    expect(listWindowStart(5, 20, 5)).toBe(3);
  });

  test("pins the window at both ends", () => {
    expect(listWindowStart(0, 20, 5)).toBe(0);
    expect(listWindowStart(19, 20, 5)).toBe(15);
  });
});
