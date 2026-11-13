/**
 * Renders key chords for people to read: menus, help, conflict messages, and button hints.
 *
 * Every client shows the chord a command answers to in the same words (`Ctrl+M`, `PageUp`,
 * `G`), so this module is renderer-neutral: it reads only the published chord grammar in
 * `extension-api/keys.ts`, which is itself import-free. Labels are derived from resolved
 * chords rather than written by hand, so a remapped command advertises the key it actually
 * answers to.
 */
import { parseKeyChord } from "../../extension-api/keys";

const NAMED_CHORD_LABELS: Readonly<Record<string, string>> = {
  escape: "Esc",
  pageup: "PageUp",
  pagedown: "PageDown",
  space: "Space",
  backspace: "Backspace",
  insert: "Insert",
  delete: "Delete",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
};

/** Title-case one chord token for display (`pageup` -> `PageUp`, `f2` -> `F2`). */
function formatChordBase(base: string) {
  const named = NAMED_CHORD_LABELS[base];
  if (named) {
    return named;
  }

  if (/^f\d{1,2}$/.test(base)) {
    return base.toUpperCase();
  }

  // Single characters are shown exactly as typed; `G` keeps its shifted form.
  return base;
}

/** Render one chord for menus, help, and conflict messages; unparsable chords pass through. */
export function formatKeyChord(chord: string): string {
  const parsed = parseKeyChord(chord);
  if ("error" in parsed) {
    return chord;
  }

  const isLetter = /^[a-z]$/.test(parsed.base);
  const modifiers = [
    parsed.ctrl ? "Ctrl" : undefined,
    parsed.meta ? "Cmd" : undefined,
    parsed.option ? "Alt" : undefined,
    // A shifted letter reads as its uppercase form, the way it is typed and
    // the way the chord grammar spells it; every other shifted key names the
    // modifier instead.
    parsed.shift && !isLetter ? "Shift" : undefined,
  ].filter((modifier): modifier is string => modifier !== undefined);
  // A bare letter is shown exactly as typed ("q"); combined with a modifier it
  // reads as a named key would ("Ctrl+M"), which is how keyboards label them.
  const base =
    isLetter && (parsed.shift || modifiers.length > 0)
      ? parsed.base.toUpperCase()
      : formatChordBase(parsed.base);

  return [...modifiers, base].join("+");
}
