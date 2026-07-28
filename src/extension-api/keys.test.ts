import { describe, expect, test } from "bun:test";
import {
  matchesKey,
  matchesKeyChord,
  parseKeyChord,
  type ExtensionKeyEvent,
  type ParsedKeyChord,
} from "./keys";

/**
 * The published chord grammar.
 *
 * These cover the grammar itself; `src/lib/commandKeys.test.ts` covers the
 * internal-only pieces built on top of it.
 */

/** Build a key event with the fields chord matching reads. */
function keyEvent(fields: ExtensionKeyEvent): ExtensionKeyEvent {
  return {
    name: "",
    sequence: "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    ...fields,
  };
}

function parsed(chord: string): ParsedKeyChord {
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

  test("refuses shift on symbols and digits, keeps it for letters and named keys", () => {
    // Shifted symbols have no layout-independent identity; the binding must
    // name the character shift produces instead.
    expect(parseKeyChord("shift+1")).toHaveProperty("error");
    expect(parseKeyChord("shift+[")).toHaveProperty("error");
    expect(parseKeyChord("ctrl+shift+.")).toHaveProperty("error");

    expect(parsed("shift+tab")).toEqual({
      base: "tab",
      ctrl: false,
      meta: false,
      option: false,
      shift: true,
    });
    expect(parsed("shift+g")).toEqual({
      base: "g",
      ctrl: false,
      meta: false,
      option: false,
      shift: true,
    });
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

  test("named keys match by name with enter/return and space aliased", () => {
    expect(matchesKeyChord(parsed("f2"), keyEvent({ name: "f2" }))).toBe(true);
    expect(matchesKeyChord(parsed("enter"), keyEvent({ name: "return" }))).toBe(true);
    expect(matchesKeyChord(parsed("pageup"), keyEvent({ name: "pageup" }))).toBe(true);
    // Space arrives named from OpenTUI's parser and as the bare character from
    // other input paths; both spell one key.
    expect(matchesKeyChord(parsed("space"), keyEvent({ name: "space" }))).toBe(true);
    expect(matchesKeyChord(parsed("space"), keyEvent({ sequence: " " }))).toBe(true);
  });

  test("shifted named keys require the shift flag", () => {
    const chord = parsed("shift+tab");
    expect(matchesKeyChord(chord, keyEvent({ name: "tab", shift: true }))).toBe(true);
    expect(matchesKeyChord(chord, keyEvent({ name: "tab" }))).toBe(false);
    expect(matchesKeyChord(parsed("tab"), keyEvent({ name: "tab", shift: true }))).toBe(false);
  });
});

describe("matchesKey", () => {
  test("parses and matches in one call", () => {
    expect(matchesKey("ctrl+n", keyEvent({ name: "n", ctrl: true }))).toBe(true);
    expect(matchesKey("ctrl+n", keyEvent({ name: "n" }))).toBe(false);
    expect(matchesKey("G", keyEvent({ name: "g", sequence: "G", shift: true }))).toBe(true);
  });

  test("an unparsable chord matches nothing", () => {
    // A typo must be a binding that never fires, never one that swallows keys.
    expect(matchesKey("ctlr+s", keyEvent({ name: "s", ctrl: true }))).toBe(false);
    expect(matchesKey("", keyEvent({ name: "s" }))).toBe(false);
    expect(matchesKey("shift+1", keyEvent({ name: "1", shift: true }))).toBe(false);
  });
});
