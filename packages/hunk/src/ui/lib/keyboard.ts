import type { KeyEvent } from "@opentui/core";
import { matchesAnyKeyChord, parseKeyChord } from "../../lib/commandKeys";
import type { KeyOwner } from "./keyRouting";

/**
 * Key predicates for the surfaces that own their keys outright, plus the
 * encoding net that `ctrl+s` still needs after it became a remappable command.
 *
 * Shortcuts are declared as key chords in the command table
 * (`appCommands.ts`), which is what makes them remappable and reportable. What
 * stays here is what modal widgets own — keys nobody rebinds, such as Escape —
 * and where terminals disagree about the encoding enough that a chord could not
 * describe the key faithfully.
 */

const CTRL_S = "\u0013";
const CTRL_S_CSI_U = "\u001b[115;5u";

/** Normalize the escape key aliases emitted by different terminal input paths. */
export function isEscapeKey(key: KeyEvent) {
  return (
    key.name === "escape" ||
    key.name === "esc" ||
    key.name === "Escape" ||
    key.sequence === "\u001b" ||
    key.raw === "\u001b"
  );
}

/**
 * Match Ctrl-S across raw, Kitty/CSI-u, and tmux control-mode encodings.
 *
 * Extra modifiers disqualify the event: the command table treats `ctrl+shift+s`
 * as a different chord, and this net must not claim it. CSI-u for plain Ctrl-S
 * is `\u001b[115;5u` (modifier 5); a shifted form is a different sequence.
 *
 * Deliberately not delegated to the published `matchesKey("ctrl+s", key)`,
 * which now understands the bare C0 byte: this predicate is wider than a chord
 * can be. It reads `raw`, a channel `ExtensionKeyEvent` does not carry, and it
 * accepts the CSI-u form the chord grammar has no spelling for. Delegating would
 * drop those encodings, so the overlap stays duplicated on purpose.
 */
export function isSaveDraftNoteKey(key: KeyEvent) {
  if (key.shift || key.meta || key.option) {
    return false;
  }

  const name = key.name?.toLowerCase();
  const sequence = key.sequence;
  const raw = key.raw;

  return (
    (key.ctrl && (name === "s" || sequence === "s" || sequence === CTRL_S)) ||
    sequence === CTRL_S ||
    raw === CTRL_S ||
    sequence === CTRL_S_CSI_U ||
    raw === CTRL_S_CSI_U
  );
}

/** Report whether one resolved chord is plain `ctrl+s`, regardless of spelling. */
function isPlainCtrlSChord(chord: string) {
  const parsed = parseKeyChord(chord);
  return (
    !("error" in parsed) &&
    parsed.ctrl &&
    parsed.base === "s" &&
    !parsed.meta &&
    !parsed.option &&
    !parsed.shift
  );
}

/**
 * Match the note-composer save command against its resolved chords.
 *
 * Remapped chords go through the command table matcher. While the resolved set
 * still includes plain `ctrl+s`, the wider encoding net from
 * {@link isSaveDraftNoteKey} stays in force so CSI-u and `raw` keep saving.
 * Unbound (empty keys) matches nothing.
 */
export function matchesSaveDraftNoteCommand(keys: readonly string[], key: KeyEvent) {
  if (keys.length === 0) {
    return false;
  }

  if (matchesAnyKeyChord(keys)(key)) {
    return true;
  }

  return keys.some(isPlainCtrlSChord) && isSaveDraftNoteKey(key);
}

/**
 * Own a focused-composer save after matching the resolved chords.
 *
 * `execute` is the caller's `executeAppCommand` for `hunk.review.saveNote`.
 * Returns `"mine"` only when that ran. A matched key whose execute fails is
 * `"focused"` so the chord is not swallowed and is not saved through a widget
 * fallback. Unmatched keys return undefined.
 */
export function noteComposerSaveOwner(
  keys: readonly string[],
  key: KeyEvent,
  execute: () => boolean,
): KeyOwner | undefined {
  if (!matchesSaveDraftNoteCommand(keys, key)) {
    return undefined;
  }

  return execute() ? "mine" : "focused";
}
