import { KeyEvent } from "@opentui/core";
import type { ParsedKeyChord } from "../../lib/commandKeys";

/** Build a synthetic key event for interactive command conflict detection. */
export function synthesizeKeyEvent(parsed: ParsedKeyChord): KeyEvent {
  const isNamed = parsed.base.length > 1;
  const isLetter = /^[a-z]$/.test(parsed.base);
  const sequence = isNamed
    ? ""
    : parsed.shift && isLetter
      ? parsed.base.toUpperCase()
      : parsed.base;

  return new KeyEvent({
    name: isNamed || isLetter ? parsed.base : sequence,
    sequence,
    raw: sequence,
    ctrl: parsed.ctrl,
    meta: parsed.meta,
    option: parsed.option,
    shift: parsed.shift,
    number: false,
    eventType: "press",
    source: "raw",
  });
}
