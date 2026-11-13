/**
 * Terminal keymap helpers: the pane keybindings manager, plus re-exports of the shared
 * keymap resolution and chord labels.
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

// Chord labels are shared with the browser client (`core/run/keyChordLabels.ts`, audit F3).
export { formatKeyChord } from "../../core/run/keyChordLabels";
