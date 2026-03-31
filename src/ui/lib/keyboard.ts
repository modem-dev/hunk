import type { KeyEvent } from "@opentui/core";

function isSpaceKey(key: KeyEvent) {
  return key.name === "space" || key.name === " " || key.sequence === " ";
}

/** Match any key alias that should scroll forward by a full viewport. */
export function isPageDownKey(key: KeyEvent) {
  return (
    key.name === "pagedown" ||
    (!key.shift && isSpaceKey(key)) ||
    key.name === "f" ||
    key.sequence === "f"
  );
}

/** Match any key alias that should scroll backward by a full viewport. */
export function isPageUpKey(key: KeyEvent) {
  return key.name === "pageup" || key.name === "b" || key.sequence === "b";
}

/** Match any key alias that should scroll forward by a single diff row. */
export function isStepDownKey(key: KeyEvent) {
  return key.name === "down" || key.name === "j" || key.sequence === "j";
}

/** Match any key alias that should scroll backward by a single diff row. */
export function isStepUpKey(key: KeyEvent) {
  return key.name === "up" || key.name === "k" || key.sequence === "k";
}

/** Match any key alias that should scroll forward by half a viewport. */
export function isHalfPageDownKey(key: KeyEvent) {
  return key.name === "d" || key.sequence === "d";
}

/** Match any key alias that should scroll backward by half a viewport. */
export function isHalfPageUpKey(key: KeyEvent) {
  return key.name === "u" || key.sequence === "u";
}

/** Match the less-style Shift+Space reverse page key. */
export function isShiftSpacePageUpKey(key: KeyEvent) {
  return key.shift && isSpaceKey(key);
}
