import type { RegisteredCommand } from "../../extensions/types";
import { matchesKeyChord, parseKeyChord, synthesizeKeyEvent } from "../../lib/commandKeys";
import type { AppCommand } from "./appCommands";

/** One extension binding refused because its chord is already taken. */
export interface ExtensionCommandConflict {
  extensionId: string;
  /** Namespaced command id, `<extensionId>.<id>`. */
  fullId: string;
  key: string;
  /** The command that already owns the chord. */
  conflictingId: string;
}

export interface BuildExtensionAppCommandsOptions {
  registered: readonly RegisteredCommand[];
  /**
   * The built-in command table, consulted for chord conflicts. Only `match`
   * and `scopes` are read, so a table built over no-op callbacks works.
   */
  builtins: readonly AppCommand[];
  /** Invoke one extension command; the caller owns context and error policy. */
  runCommand: (registered: RegisteredCommand) => void;
}

/** The dispatchable extension commands, plus every binding refused for a conflict. */
export interface ExtensionAppCommands {
  commands: AppCommand[];
  conflicts: ExtensionCommandConflict[];
}

/**
 * Adapt registered extension commands into dispatch-table entries.
 *
 * A chord that collides with a built-in shortcut — or with an earlier
 * extension's binding — is refused and reported, never silently shadowed:
 * built-ins keep every key they ship with, and between extensions load order
 * is the tiebreaker, same as everywhere else in the registry. Conflicts are
 * detected by synthesizing the key event a chord describes and probing every
 * matcher, because built-in commands match with predicates rather than chords.
 * Extension commands run in the review scope only: pager mode is a pager, and
 * modal surfaces own their keys outright.
 */
export function buildExtensionAppCommands(
  options: BuildExtensionAppCommandsOptions,
): ExtensionAppCommands {
  const commands: AppCommand[] = [];
  const conflicts: ExtensionCommandConflict[] = [];

  for (const registered of options.registered) {
    const { command } = registered;
    const fullId = `${registered.extensionId}.${command.id}`;
    // A command without a binding stays registered but has nothing to dispatch.
    if (command.key === undefined) {
      continue;
    }

    // Registration already validated the chord; an error here is unreachable
    // short of registry tampering, and skipping is the safe answer to it.
    const parsed = parseKeyChord(command.key);
    if ("error" in parsed) {
      continue;
    }

    const probe = synthesizeKeyEvent(parsed);
    const taken =
      options.builtins.find(
        (builtin) => builtin.scopes.includes("review") && builtin.match(probe),
      ) ?? commands.find((extension) => extension.match(probe));
    if (taken) {
      conflicts.push({
        extensionId: registered.extensionId,
        fullId,
        key: command.key,
        conflictingId: taken.id,
      });
      continue;
    }

    commands.push({
      id: fullId,
      title: command.title,
      scopes: ["review"],
      keyLabels: [command.key],
      match: (key) => matchesKeyChord(parsed, key),
      run: () => options.runCommand(registered),
      closesMenu: true,
    });
  }

  return { commands, conflicts };
}
