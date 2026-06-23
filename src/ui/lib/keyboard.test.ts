import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { isPageUpKey } from "./keyboard";

const key = (over: Partial<KeyEvent>): KeyEvent =>
  ({ name: "", sequence: "", ...over }) as KeyEvent;

describe("isPageUpKey", () => {
  test("unmodified b scrolls a page up", () => {
    expect(isPageUpKey(key({ name: "b", sequence: "b" }))).toBe(true);
    expect(isPageUpKey(key({ name: "pageup" }))).toBe(true);
  });

  test("Shift+B is not page up, leaving it free for the borderless toggle", () => {
    expect(isPageUpKey(key({ name: "b", sequence: "B", shift: true }))).toBe(false);
  });
});
