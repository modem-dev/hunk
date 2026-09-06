import type { KeyEvent } from "@opentui/core";

/**
 * Key predicates for the surfaces that own their keys outright.
 *
 * Shortcuts are declared as key chords in the command table
 * (`appCommands.ts`), which is what makes them remappable and reportable. What
 * stays here is what modal widgets own — keys nobody rebinds — and where
 * terminals disagree about the encoding enough that a chord could not describe
 * the key faithfully.
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
 * Deliberately not delegated to the published `matchesKey("ctrl+s", key)`,
 * which now understands the bare C0 byte: this predicate is wider than a chord
 * can be. It reads `raw`, a channel `ExtensionKeyEvent` does not carry; it
 * accepts the CSI-u form the chord grammar has no spelling for; and it treats
 * a bare `\u0013` byte as Ctrl-S whatever else the event reports, where chord
 * matching must stay strict about modifiers so `ctrl+shift+s` remains a
 * different binding. Delegating would narrow saving a draft note, so the
 * overlap stays duplicated on purpose.
 */
export function isSaveDraftNoteKey(key: KeyEvent) {
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
