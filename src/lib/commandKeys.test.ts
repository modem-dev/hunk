import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { matchesKeyChord, parseKeyChord, synthesizeKeyEvent } from "./commandKeys";

/** Build a key event with the fields chord matching reads. */
function keyEvent(fields: Partial<KeyEvent>): KeyEvent {
  return {
    name: "",
    sequence: "",
    raw: "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    ...fields,
  } as KeyEvent;
}

function parsed(chord: string) {
  const result = parseKeyChord(chord);
  if ("error" in result) {
    throw new Error(result.error);
  }

  return result;
}

describe("parseKeyChord", () => {
  test("parses plain keys, modifiers, and named keys", () => {
    expect(parsed("y")).toEqual({
      base: "y",
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
    });
    expect(parsed("ctrl+shift+m")).toEqual({
      base: "m",
      ctrl: true,
      meta: false,
      option: false,
      shift: true,
    });
    expect(parsed("F2")).toEqual({
      base: "f2",
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
    });
    expect(parsed("alt+left")).toEqual({
      base: "left",
      ctrl: false,
      meta: false,
      option: true,
      shift: false,
    });
  });

  test("treats an uppercase letter as its shifted form", () => {
    expect(parsed("G")).toEqual({
      base: "g",
      ctrl: false,
      meta: false,
      option: false,
      shift: true,
    });
  });

  test("refuses unknown named keys and dangling modifiers", () => {
    expect(parseKeyChord("f13")).toHaveProperty("error");
    expect(parseKeyChord("ctlr+s")).toHaveProperty("error");
    expect(parseKeyChord("ctrl+")).toHaveProperty("error");
    expect(parseKeyChord("")).toHaveProperty("error");
  });
});

describe("matchesKeyChord", () => {
  test("letters require the exact shift state", () => {
    const lower = parsed("g");
    expect(matchesKeyChord(lower, keyEvent({ name: "g", sequence: "g" }))).toBe(true);
    expect(matchesKeyChord(lower, keyEvent({ name: "g", sequence: "G", shift: true }))).toBe(false);

    const upper = parsed("G");
    expect(matchesKeyChord(upper, keyEvent({ name: "g", sequence: "G", shift: true }))).toBe(true);
    // Terminals that report `G` without a shift flag still match by sequence.
    expect(matchesKeyChord(upper, keyEvent({ name: "g", sequence: "G" }))).toBe(true);
    expect(matchesKeyChord(upper, keyEvent({ name: "g", sequence: "g" }))).toBe(false);
  });

  test("modifiers must match exactly", () => {
    const chord = parsed("ctrl+r");
    expect(matchesKeyChord(chord, keyEvent({ name: "r", ctrl: true }))).toBe(true);
    expect(matchesKeyChord(chord, keyEvent({ name: "r" }))).toBe(false);
    expect(matchesKeyChord(parsed("r"), keyEvent({ name: "r", ctrl: true }))).toBe(false);
  });

  test("symbols match by sequence and ignore the shift flag", () => {
    const chord = parsed("{");
    expect(matchesKeyChord(chord, keyEvent({ name: "[", sequence: "{", shift: true }))).toBe(true);
    expect(matchesKeyChord(chord, keyEvent({ sequence: "{" }))).toBe(true);
  });

  test("named keys match by name with enter/return aliased", () => {
    expect(matchesKeyChord(parsed("f2"), keyEvent({ name: "f2" }))).toBe(true);
    expect(matchesKeyChord(parsed("enter"), keyEvent({ name: "return" }))).toBe(true);
    expect(matchesKeyChord(parsed("pageup"), keyEvent({ name: "pageup" }))).toBe(true);
  });
});

describe("synthesizeKeyEvent", () => {
  test("round-trips through the matcher for every chord form", () => {
    for (const chord of ["y", "G", "ctrl+shift+m", "f10", "{", "alt+left", "."]) {
      expect(matchesKeyChord(parsed(chord), synthesizeKeyEvent(parsed(chord)))).toBe(true);
    }
  });
});
