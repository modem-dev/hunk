/**
 * Terminal keymap helpers: the pane keybindings manager and chord labels.
 *
 * Resolving which chords each command answers to lives in `core/run/keymap.ts` and is
 * re-exported here for terminal modules.
 */
import type { ExtensionPaneKeybindings } from "../../extension-api/types";
import { matchesKeyChord, parseKeyChord, type ParsedKeyChord } from "../../lib/commandKeys";

export {
  resolveCommandKeys,
  type CommandKeyDefaults,
  type KeymapIssue,
  type ResolveCommandKeysOptions,
  type ResolvedKeymap,
} from "../../core/run/keymap";

const NO_KEY_CHORDS: readonly string[] = Object.freeze([]);

/**
 * Build the immutable keybindings manager injected into pane components.
 *
 * Components receive command ids rather than raw default chords, exactly as
 * Pi custom components receive its `KeybindingsManager`. Capturing the
 * resolved map here means a component's local key handling observes the same
 * remaps, unbindings, and extension bindings as the app dispatcher.
 */
export function createExtensionPaneKeybindings(
  resolvedKeys: ReadonlyMap<string, readonly string[]>,
): ExtensionPaneKeybindings {
  const keysByCommand = new Map(
    Array.from(resolvedKeys, ([commandId, keys]) => [commandId, Object.freeze([...keys])]),
  );
  const parsedByCommand = new Map(
    Array.from(keysByCommand, ([commandId, keys]) => [
      commandId,
      keys
        .map((key) => parseKeyChord(key))
        .filter((key): key is ParsedKeyChord => !("error" in key)),
    ]),
  );

  const keybindings: ExtensionPaneKeybindings = {
    matches(key, commandId) {
      return parsedByCommand.get(commandId)?.some((chord) => matchesKeyChord(chord, key)) ?? false;
    },
    getKeys(commandId) {
      return keysByCommand.get(commandId) ?? NO_KEY_CHORDS;
    },
  };

  return Object.freeze(keybindings);
}

const NAMED_CHORD_LABELS: Record<string, string> = {
  escape: "Esc",
  pageup: "PageUp",
  pagedown: "PageDown",
  space: "Space",
  backspace: "Backspace",
  insert: "Insert",
  delete: "Delete",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
};

/** Title-case one chord token for display (`pageup` -> `PageUp`, `f2` -> `F2`). */
function formatChordBase(base: string) {
  const named = NAMED_CHORD_LABELS[base];
  if (named) {
    return named;
  }

  if (/^f\d{1,2}$/.test(base)) {
    return base.toUpperCase();
  }

  // Single characters are shown exactly as typed; `G` keeps its shifted form.
  return base;
}

/**
 * Render one chord for menus, help, and conflict messages.
 *
 * Labels are derived from the resolved binding rather than written by hand, so
 * a remapped command advertises the key it actually answers to.
 */
export function formatKeyChord(chord: string): string {
  const parsed = parseKeyChord(chord);
  if ("error" in parsed) {
    return chord;
  }

  const isLetter = /^[a-z]$/.test(parsed.base);
  const modifiers = [
    parsed.ctrl ? "Ctrl" : undefined,
    parsed.meta ? "Cmd" : undefined,
    parsed.option ? "Alt" : undefined,
    // A shifted letter reads as its uppercase form, the way it is typed and
    // the way the chord grammar spells it; every other shifted key names the
    // modifier instead.
    parsed.shift && !isLetter ? "Shift" : undefined,
  ].filter((modifier): modifier is string => modifier !== undefined);
  // A bare letter is shown exactly as typed ("q"); combined with a modifier it
  // reads as a named key would ("Ctrl+M"), which is how keyboards label them.
  const base =
    isLetter && (parsed.shift || modifiers.length > 0)
      ? parsed.base.toUpperCase()
      : formatChordBase(parsed.base);

  return [...modifiers, base].join("+");
}
