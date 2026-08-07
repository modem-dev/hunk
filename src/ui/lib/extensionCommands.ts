import type { KeyEvent } from "@opentui/core";
import type { RegisteredCommand } from "../../extensions/types";
import {
  matchesKeyChord,
  parseKeyChordOrUndefined,
  synthesizeKeyEvent,
  toKeyChordList,
} from "../../lib/commandKeys";
import type { AppCommand, ResolvedCommandKeys } from "./appCommands";
import { formatKeyChord } from "./keymap";

/** One extension binding refused because its chord is already taken. */
export interface ExtensionCommandConflict {
  extensionId: string;
  /** Namespaced command id, `<extensionId>.<id>`. */
  fullId: string;
  /** The one chord that was refused; the command's other chords may still be bound. */
  key: string;
  /** The command that already owns the chord. */
  conflictingId: string;
}

export interface BuildExtensionAppCommandsOptions {
  registered: readonly RegisteredCommand[];
  /**
   * The built-in command table, consulted for chord conflicts. Only `match` is
   * read, so a table built over no-op callbacks works.
   */
  builtins: readonly AppCommand[];
  /**
   * Chords resolved against the user's `[keybindings]`, keyed by namespaced
   * command id. A resolved entry replaces the chords the extension declared.
   */
  resolvedKeys?: ResolvedCommandKeys;
  /** Invoke one extension command; the caller owns context and error policy. */
  runCommand: (registered: RegisteredCommand) => void;
}

/** The dispatchable extension commands, plus every binding refused for a conflict. */
export interface ExtensionAppCommands {
  commands: AppCommand[];
  conflicts: ExtensionCommandConflict[];
}

/** One chord already claimed, and the command that claimed it. */
interface ClaimedChord {
  commandId: string;
  match: (key: KeyEvent) => boolean;
}

/**
 * Adapt registered extension commands into dispatch-table entries.
 *
 * A chord that collides with a built-in shortcut — or with an earlier
 * extension's binding — is refused and reported, never silently shadowed:
 * built-ins keep every key they hold, and between extensions load order is the
 * tiebreaker, same as everywhere else in the registry. Conflicts are detected
 * by synthesizing the key event a chord describes and probing every matcher,
 * because a command may match with a predicate rather than chords. Refusal is
 * per chord, not per command: a command bound to three keys, one of them taken,
 * keeps the other two and reports the one it lost. Modal surfaces still own
 * their keys outright, so a dialog or an open menu answers before any command.
 *
 * Every registered command becomes a table entry, including one left with no
 * chord at all: it never matches a key, but it is still listed in the
 * Extensions menu and still runnable by id from there.
 */
export function buildExtensionAppCommands(
  options: BuildExtensionAppCommandsOptions,
): ExtensionAppCommands {
  const commands: AppCommand[] = [];
  const conflicts: ExtensionCommandConflict[] = [];
  // Chords earlier extension commands took, in the order they took them.
  const claimed: ClaimedChord[] = [];

  for (const registered of options.registered) {
    const { command } = registered;
    const fullId = `${registered.extensionId}.${command.id}`;
    const declared = options.resolvedKeys?.get(fullId) ?? toKeyChordList(command.key);
    const bound: Array<{ chord: string; match: (key: KeyEvent) => boolean }> = [];
    for (const chord of declared) {
      // Registration already validated the chord; an error here is unreachable
      // short of registry tampering, and skipping is the safe answer to it.
      const parsed = parseKeyChordOrUndefined(chord);
      if (!parsed) {
        continue;
      }

      const probe = synthesizeKeyEvent(parsed);
      const takenBy =
        options.builtins.find((builtin) => builtin.match(probe))?.id ??
        claimed.find((entry) => entry.match(probe))?.commandId;
      if (takenBy !== undefined) {
        conflicts.push({
          extensionId: registered.extensionId,
          fullId,
          key: chord,
          conflictingId: takenBy,
        });
        continue;
      }

      const match = (key: KeyEvent) => matchesKeyChord(parsed, key);
      claimed.push({ commandId: fullId, match });
      bound.push({ chord, match });
    }

    commands.push({
      id: fullId,
      title: command.title,
      keys: bound.map((binding) => binding.chord),
      keyLabels: bound.map((binding) => formatKeyChord(binding.chord)),
      match: (key) => bound.some((binding) => binding.match(key)),
      run: () => options.runCommand(registered),
      closesMenu: true,
    });
  }

  return { commands, conflicts };
}

/**
 * Every registered extension command's declared chords, for keymap resolution.
 *
 * Reported under the namespaced id the user writes in `[keybindings]`, so an
 * extension command is remappable exactly like a built-in one.
 */
export function extensionCommandKeyDefaults(
  registered: readonly RegisteredCommand[],
): Array<{ id: string; defaultKeys: readonly string[] }> {
  return registered.map((entry) => ({
    id: `${entry.extensionId}.${entry.command.id}`,
    defaultKeys: toKeyChordList(entry.command.key),
  }));
}
