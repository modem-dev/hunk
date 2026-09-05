import { describe, expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { matchesKeyChord, parseKeyChord, toKeyChordList } from "./commandKeys";
import { synthesizeKeyEvent } from "../ui/lib/syntheticKeyEvent";

/**
 * The internal-only pieces of chord handling.
 *
 * The grammar itself is published as `hunkdiff/extension` and covered by
 * `src/extension-api/keys.test.ts`; what lives here is what only Hunk needs.
 */

function parsed(chord: string) {
  const result = parseKeyChord(chord);
  if ("error" in result) {
    throw new Error(result.error);
  }

  return result;
}

/** Decode a real terminal sequence or fail the test when OpenTUI rejects it. */
function decodedKey(sequence: string, useKittyKeyboard: boolean) {
  const key = parseKeypress(sequence, { useKittyKeyboard });
  if (!key) {
    throw new Error(`Could not decode terminal key ${JSON.stringify(sequence)}`);
  }

  return key;
}

describe("terminal modifier protocols", () => {
  test("matches alt in legacy, explicit ANSI, and Kitty encodings", () => {
    const alt = parsed("alt+n");

    expect(matchesKeyChord(alt, decodedKey("\u001bn", false))).toBe(true);
    expect(matchesKeyChord(alt, decodedKey("\u001b[27;3;110~", false))).toBe(true);
    expect(matchesKeyChord(alt, decodedKey("\u001b[110;3u", true))).toBe(true);
  });

  test("distinguishes Kitty meta from Kitty alt", () => {
    const kittyAlt = decodedKey("\u001b[110;3u", true);
    const kittyMeta = decodedKey("\u001b[110;33u", true);

    expect(matchesKeyChord(parsed("alt+n"), kittyMeta)).toBe(false);
    expect(matchesKeyChord(parsed("meta+n"), kittyAlt)).toBe(false);
    expect(matchesKeyChord(parsed("meta+n"), kittyMeta)).toBe(true);
  });
});

describe("synthesizeKeyEvent", () => {
  test("round-trips through the matcher for every chord form", () => {
    for (const chord of ["y", "G", "ctrl+shift+m", "f10", "{", "alt+left", ".", "space"]) {
      expect(matchesKeyChord(parsed(chord), synthesizeKeyEvent(parsed(chord)))).toBe(true);
    }
  });

  test("returns a complete key event", () => {
    const event = synthesizeKeyEvent(parsed("ctrl+r"));

    expect(event).toBeInstanceOf(KeyEvent);
    expect({ eventType: event.eventType, source: event.source }).toEqual({
      eventType: "press",
      source: "raw",
    });
    event.preventDefault();
    event.stopPropagation();
    expect({
      defaultPrevented: event.defaultPrevented,
      propagationStopped: event.propagationStopped,
    }).toEqual({
      defaultPrevented: true,
      propagationStopped: true,
    });
  });
});

describe("toKeyChordList", () => {
  test("widens both declared binding forms into one list", () => {
    expect(toKeyChordList(undefined)).toEqual([]);
    expect(toKeyChordList("y")).toEqual(["y"]);
    expect(toKeyChordList(["y", "ctrl+g"])).toEqual(["y", "ctrl+g"]);
  });
});
