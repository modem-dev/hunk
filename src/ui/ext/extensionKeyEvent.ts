import type { KeyEvent } from "@opentui/core";
import type { ExtensionKeyEvent } from "../../extension-api/types";

/** Copy a host key into the frozen, method-free shape published to extensions. */
export function toExtensionKeyEvent(key: KeyEvent): ExtensionKeyEvent {
  return Object.freeze({
    name: key.name,
    sequence: key.sequence,
    ctrl: key.ctrl,
    meta: key.meta,
    option: key.option,
    shift: key.shift,
  });
}
