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
import type { ActionDef, ActionIdForScope, ActionScope } from "./actions";
import type { KeySpec } from "./parse";

/**
 * Per-scope keymap. Each scope only stores the action ids that legally belong
 * to it, so `keymap.global["menu.close"]` is rejected at compile time.
 */
export type Keymap = {
  [S in ActionScope]: Partial<Record<ActionIdForScope<S>, KeySpec[]>>;
};

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

/**
 * Look up the specs for an action by its registry definition. Use this when
 * iterating `ACTIONS` (e.g. building the help dialog or asserting every
 * default is populated) — it sidesteps the per-scope `Keymap` index narrowing
 * that callers can't satisfy when `action` is a generic `ActionDef`.
 */
export function getActionSpecs(keymap: Keymap, action: ActionDef): KeySpec[] {
  const scopeMap = keymap[action.scope] as Partial<Record<string, KeySpec[]>>;
  return scopeMap[action.id] ?? [];
}

/** True when any spec bound to `(scope, action)` matches the event. */
export function matchesAction<S extends ActionScope>(
  keymap: Keymap,
  scope: S,
  action: ActionIdForScope<S>,
  key: KeyEvent,
): boolean {
  const scopeMap = keymap[scope] as Partial<Record<string, KeySpec[]>>;
  const specs = scopeMap[action];
  if (!specs || specs.length === 0) return false;
  return specs.some((spec) => matchesKey(spec, key));
}

/**
 * Resolve which action (if any) is bound to the live event in this scope.
 * Used when the caller wants to dispatch by id rather than poll-by-action.
 *
 * **Collision contract:** when two actions share a key (e.g. `<space>` matches
 * both `scroll.pageDown` and `scroll.pageUp` under modifier-permissive
 * matching), this function returns whichever action was inserted first into
 * the scope map — i.e. whichever appears first in the `ACTIONS` registry for
 * that scope. The hook does NOT use this for primary dispatch; it polls
 * actions in explicit priority order (e.g. `scroll.pageUp` before
 * `scroll.pageDown` for Shift+Space). Callers that need a specific precedence
 * must replicate that ordering or use `matchesAction` per-action.
 */
export function findActionForKey<S extends ActionScope>(
  keymap: Keymap,
  scope: S,
  key: KeyEvent,
): ActionIdForScope<S> | null {
  const scopeMap = keymap[scope] as Partial<Record<string, KeySpec[]>> | undefined;
  if (!scopeMap) return null;

  for (const [action, specs] of Object.entries(scopeMap)) {
    if (!specs || specs.length === 0) continue;
    if (specs.some((spec) => matchesKey(spec, key))) {
      return action as ActionIdForScope<S>;
    }
  }
  return null;
}
