import type { KeyEvent } from "@opentui/core";
import type { AppCommand, ResolvedCommandKeys } from "../lib/appCommands";
import type { CommandKeyDefaults } from "../lib/keymap";
import { formatKeyChord } from "../lib/keymap";
import { matchesAnyKeyChord } from "../../lib/commandKeys";

export interface SurfaceCommandDefinition extends CommandKeyDefaults {
  title: string;
  publicToExtensions?: boolean;
  verticalDirection?: AppCommand["verticalDirection"];
  closesMenu?: boolean;
}

/** Bind surface-specific actions to the shared semantic command and effective-key contract. */
export function buildSurfaceCommands<Definition extends SurfaceCommandDefinition>(
  definitions: readonly Definition[],
  options: {
    resolvedKeys?: ResolvedCommandKeys;
    isEnabled?: (entry: Definition) => boolean;
    run: (entry: Definition, key: KeyEvent, count: number) => void;
  },
): AppCommand[] {
  return definitions.map((entry) => {
    const keys = options.resolvedKeys?.get(entry.id) ?? entry.defaultKeys;
    return {
      ...entry,
      keys,
      keyLabels: keys.map(formatKeyChord),
      publicToExtensions: entry.publicToExtensions ?? false,
      isEnabled: () => options.isEnabled?.(entry) ?? true,
      match: matchesAnyKeyChord(keys),
      run: (key, count) => options.run(entry, key, count),
    };
  });
}
