import type { KeyEvent } from "@opentui/core";
import { matchesKeyChord, parseKeyChord, type ParsedKeyChord } from "../extension-api/keys";

/**
 * Key-chord parsing and matching for the command registry.
 *
 * The grammar itself lives in `packages/hunk/src/extension-api/keys.ts` because extensions
 * need it too — it is published as part of `hunkdiff/extension` — and is
 * re-exported here so internal code keeps importing key handling from one
 * place. What stays local is what extensions have no use for: synthesizing the
 * event a chord describes, which only conflict detection needs.
 *
 * A chord is the textual form a binding is declared in — `"s"`, `"G"`,
 * `"ctrl+r"`, `"f10"`, `"["` — used by built-in command defaults, extension
 * `registerCommand` calls, and the user's `[keybindings]` config table. A
 * command may still match with a predicate where one logical action cannot be
 * spelled as chords; chords and predicates meet at the dispatch table's `match`
 * shape so the dispatch loop treats them identically.
 */
export { matchesKeyChord, parseKeyChord } from "../extension-api/keys";
export type { ParsedKeyChord } from "../extension-api/keys";

/**
 * Normalize one declared binding into the list of chords it names.
 *
 * A command may declare a single chord or several; every consumer works in
 * lists, so the string form is widened here once rather than at each use.
 */
export function toKeyChordList(key: string | readonly string[] | undefined): readonly string[] {
  if (key === undefined) {
    return [];
  }

  return typeof key === "string" ? [key] : [...key];
}

// Parsing is pure over the chord string, and the command table is rebuilt on
// every App render, so results are memoized by chord rather than re-derived
// dozens of times per frame. The key space is the set of chords in config and
// code, so the cache is naturally bounded.
const parsedChordCache = new Map<string, ParsedKeyChord | undefined>();

/** Parse one chord, returning nothing when it cannot be a binding. */
export function parseKeyChordOrUndefined(chord: string): ParsedKeyChord | undefined {
  if (parsedChordCache.has(chord)) {
    return parsedChordCache.get(chord);
  }

  const parsed = parseKeyChord(chord);
  const result = "error" in parsed ? undefined : parsed;
  parsedChordCache.set(chord, result);
  return result;
}

/** Build one matcher that accepts any of the given chords, skipping unparsable ones. */
export function matchesAnyKeyChord(chords: readonly string[]): (key: KeyEvent) => boolean {
  const parsed = chords
    .map((chord) => parseKeyChordOrUndefined(chord))
    .filter((chord): chord is ParsedKeyChord => chord !== undefined);

  return (key: KeyEvent) => parsed.some((chord) => matchesKeyChord(chord, key));
}
