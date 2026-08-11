import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { toExtensionKeyEvent } from "./extensionKeyEvent";

describe("toExtensionKeyEvent", () => {
  test("returns a frozen method-free snapshot instead of the host event", () => {
    const host = {
      name: "g",
      sequence: "G",
      ctrl: false,
      meta: false,
      option: true,
      shift: true,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as KeyEvent;

    const snapshot = toExtensionKeyEvent(host);

    expect(snapshot).toEqual({
      name: "g",
      sequence: "G",
      ctrl: false,
      meta: false,
      option: true,
      shift: true,
    });
    expect(snapshot).not.toBe(host);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect("preventDefault" in snapshot).toBe(false);
    expect("stopPropagation" in snapshot).toBe(false);
  });
});
