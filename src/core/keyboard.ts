import type { KeyEvent } from "@opentui/core";

/** Normalize the escape key aliases emitted by different terminal input paths. */
export function isEscapeKey(key: KeyEvent) {
  return key.name === "escape" || key.name === "esc";
}
