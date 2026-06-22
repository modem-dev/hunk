import type { KeyEvent } from "@opentui/core";

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

/** Match Ctrl-S across raw, Kitty/CSI-u, and tmux control-mode encodings. */
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

/** Match the unmodified review-note shortcut without stealing terminal copy chords. */
export function isCreateReviewNoteKey(key: KeyEvent) {
  return (
    (key.name === "c" || key.sequence === "c") &&
    !key.ctrl &&
    !key.meta &&
    !key.option &&
    !key.shift
  );
}
