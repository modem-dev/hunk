import { describe, expect, test } from "bun:test";
import { matchesKeyChord, parseKeyChord, synthesizeKeyEvent, toKeyChordList } from "./commandKeys";

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

describe("synthesizeKeyEvent", () => {
  test("round-trips through the matcher for every chord form", () => {
    for (const chord of ["y", "G", "ctrl+shift+m", "f10", "{", "alt+left", ".", "space"]) {
      expect(matchesKeyChord(parsed(chord), synthesizeKeyEvent(parsed(chord)))).toBe(true);
    }
  });
});

describe("toKeyChordList", () => {
  test("widens both declared binding forms into one list", () => {
    expect(toKeyChordList(undefined)).toEqual([]);
    expect(toKeyChordList("y")).toEqual(["y"]);
    expect(toKeyChordList(["y", "ctrl+g"])).toEqual(["y", "ctrl+g"]);
  });
});
