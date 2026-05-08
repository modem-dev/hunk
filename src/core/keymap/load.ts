/**
 * Build a keymap from defaults and apply user/repo TOML overrides.
 *
 * Layering convention (caller-driven):
 *   defaults  -> user config  -> repo config
 *
 * Each layer can override individual `[keybindings.<scope>]` keys; missing
 * keys keep the previous layer's value. To unbind a default, the user sets
 * the action to `<disabled>` (parsed elsewhere as an empty spec list).
 */

import { isRecord } from "../config";
import {
  ACTIONS,
  ACTIONS_BY_SCOPE,
  type ActionId,
  type ActionScope,
} from "./actions";
import type { Keymap } from "./match";
import { parseBinding, type KeySpec } from "./parse";

const ACTION_SCOPES = Object.keys(ACTIONS_BY_SCOPE) as ActionScope[];

const KNOWN_IDS_BY_SCOPE: Record<ActionScope, Set<ActionId>> = ACTION_SCOPES.reduce(
  (acc, scope) => {
    acc[scope] = new Set(ACTIONS_BY_SCOPE[scope].map((action) => action.id));
    return acc;
  },
  {} as Record<ActionScope, Set<ActionId>>,
);

/** Build a fresh keymap populated from the action registry's defaults. */
export function loadKeymapDefaults(): Keymap {
  const keymap: Keymap = {
    global: {},
    pager: {},
    menu: {},
    filter: {},
  };

  for (const action of ACTIONS) {
    const parsed = parseBinding(action.defaultKeys);
    keymap[action.scope][action.id] = parsed.disabled ? [] : parsed.specs;
  }

  return keymap;
}

function isStringOrStringArray(value: unknown): value is string | string[] {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Clone a keymap so override application doesn't mutate the input. */
function cloneKeymap(base: Keymap): Keymap {
  return {
    global: { ...base.global },
    pager: { ...base.pager },
    menu: { ...base.menu },
    filter: { ...base.filter },
  };
}

/**
 * Apply `[keybindings.<scope>]` overrides from a parsed TOML object onto a
 * base keymap. Unknown action ids and malformed bindings emit a one-line
 * stderr warning and are otherwise ignored — config errors should never
 * abort startup.
 */
export function applyKeymapOverrides(
  base: Keymap,
  source: Record<string, unknown>,
): Keymap {
  const keybindings = source.keybindings;
  if (!isRecord(keybindings)) return base;

  const next = cloneKeymap(base);

  // Walk the user's scopes once first so we can warn on typos like
  // `[keybindings.gloabl]` instead of silently dropping the whole block.
  for (const scope of Object.keys(keybindings)) {
    if (!(ACTION_SCOPES as readonly string[]).includes(scope)) {
      process.stderr.write(
        `[hunk] keybindings: unknown scope "${scope}" — ignored. (valid: ${ACTION_SCOPES.join(", ")})\n`,
      );
    }
  }

  for (const scope of ACTION_SCOPES) {
    const scopeOverrides = keybindings[scope];
    if (!isRecord(scopeOverrides)) continue;

    const knownIds = KNOWN_IDS_BY_SCOPE[scope];

    for (const [actionId, value] of Object.entries(scopeOverrides)) {
      if (!knownIds.has(actionId as ActionId)) {
        process.stderr.write(
          `[hunk] keybindings: unknown action "${scope}.${actionId}" — ignored.\n`,
        );
        continue;
      }
      // Detect `quit = []` before the array passes the type check below — an
      // empty array would otherwise silently disable the action without the
      // explicit `<disabled>` sentinel.
      if (Array.isArray(value) && value.length === 0) {
        process.stderr.write(
          `[hunk] keybindings: empty binding for "${scope}.${actionId}" — use "<disabled>" to unbind. ignored.\n`,
        );
        continue;
      }
      if (!isStringOrStringArray(value)) {
        process.stderr.write(
          `[hunk] keybindings: invalid binding for "${scope}.${actionId}" (expected string or string[]) — ignored.\n`,
        );
        continue;
      }
      const parsed = parseBinding(value);
      for (const rejected of parsed.rejectedTokens) {
        process.stderr.write(
          `[hunk] keybindings: unrecognized token "${rejected}" for "${scope}.${actionId}" — skipped.\n`,
        );
      }
      if (parsed.mixedWithDisabled) {
        process.stderr.write(
          `[hunk] keybindings: "${scope}.${actionId}" mixes "<disabled>" with other tokens — entire binding disabled.\n`,
        );
      }
      const specs: KeySpec[] = parsed.disabled ? [] : parsed.specs;
      next[scope][actionId as ActionId] = specs;
    }
  }

  return next;
}
