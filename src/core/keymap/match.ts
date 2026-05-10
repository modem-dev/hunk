/**
 * Match parsed key specs against live KeyEvent objects emitted by OpenTUI's
 * keyboard layer. A spec matches a KeyEvent when:
 *
 *   - sequence specs (bare printable like `q`, `?`, `[`): require
 *     `key.sequence === spec.sequence`. Modifiers on the live event are
 *     ignored — the literal-sequence form is "type this character", not
 *     "press this physical key".
 *   - name specs (`<esc>`, `<tab>`, `<c-c>`, etc.): require `key.name` match
 *     and require every modifier flagged on the spec to be present on the
 *     event. Spec modifiers are "must-be-present"; spec-without-modifier
 *     does NOT require the modifier to be absent. This preserves the
 *     pre-keymap behavior where bare-character handlers fired regardless of
 *     incidental shift state.
 */

import type { KeyEvent } from "@opentui/core";
import { isEscapeKey } from "../keyboard";
import type { ActionId, ActionScope } from "./actions";
import type { KeySpec } from "./parse";

export type Keymap = Record<ActionScope, Partial<Record<ActionId, KeySpec[]>>>;

/** Match a single KeySpec against a live KeyEvent. */
export function matchesKey(spec: KeySpec, key: KeyEvent): boolean {
  if (spec.sequence !== undefined) {
    if (key.sequence === spec.sequence) return true;
    // Defensive parity for single-character specs — some OpenTUI paths
    // populate `key.name` without `key.sequence`. Gate on `!key.shift` so a
    // lowercase-letter spec doesn't shadow an uppercase-letter spec on
    // Shift+letter events: OpenTUI lowercases `key.name` and sets
    // `key.shift = true` for `A-Z`, which would otherwise let `g` match
    // Shift+G (the literal `key.sequence === "G"`) ahead of an explicit `G`
    // binding.
    if (spec.sequence.length === 1 && !key.shift && key.name === spec.sequence) {
      return true;
    }
    return false;
  }

  if (spec.name === undefined) return false;

  if (!nameMatches(spec.name, key)) return false;

  // Required modifiers must be present. OpenTUI exposes alt under `option`.
  if (spec.ctrl && !key.ctrl) return false;
  if (spec.shift && !key.shift) return false;
  if (spec.meta && !key.meta) return false;
  if (spec.alt && !key.option) return false;

  return true;
}

/**
 * Compare a spec's key name to the live event, accounting for the small set
 * of OpenTUI/terminal aliases (`enter`/`return`, `escape`/`esc`, and the
 * space variants).
 */
function nameMatches(specName: string, key: KeyEvent): boolean {
  if (specName === "enter") {
    return key.name === "return" || key.name === "enter";
  }
  if (specName === "escape") {
    return isEscapeKey(key);
  }
  if (specName === "space") {
    return key.name === "space" || key.name === " " || key.sequence === " ";
  }
  return key.name === specName;
}

/** True when any spec bound to `(scope, action)` matches the event. */
export function matchesAction(
  keymap: Keymap,
  scope: ActionScope,
  action: ActionId,
  key: KeyEvent,
): boolean {
  const specs = keymap[scope]?.[action];
  if (!specs || specs.length === 0) return false;
  return specs.some((spec) => matchesKey(spec, key));
}

/**
 * Resolve which action (if any) is bound to the live event in this scope.
 * Used when the caller wants to dispatch by id rather than poll-by-action.
 */
export function findActionForKey(
  keymap: Keymap,
  scope: ActionScope,
  key: KeyEvent,
): ActionId | null {
  const scopeMap = keymap[scope];
  if (!scopeMap) return null;

  for (const [action, specs] of Object.entries(scopeMap)) {
    if (!specs || specs.length === 0) continue;
    if (specs.some((spec) => matchesKey(spec, key))) {
      return action as ActionId;
    }
  }
  return null;
}
