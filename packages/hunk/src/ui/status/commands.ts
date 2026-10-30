import { STATUS_COMMAND_CATALOG, type StatusCommandId } from "../../core/run/statusCommandCatalog";
export {
  STATUS_COMMAND_CATALOG as STATUS_COMMANDS,
  type StatusCommandId,
} from "../../core/run/statusCommandCatalog";
import { matchesAnyKeyChord } from "../../lib/commandKeys";
import type { AppCommand, ResolvedCommandKeys } from "../lib/appCommands";
import { formatKeyChord } from "../lib/keymap";

/** Bind the same effective chords and availability to menus, help and keyboard dispatch. */
export function buildStatusCommands(
  handlers: Record<StatusCommandId, () => void>,
  keys: ResolvedCommandKeys,
  enabled: (id: StatusCommandId) => boolean,
): AppCommand[] {
  return STATUS_COMMAND_CATALOG.map((entry) => {
    const resolved = keys.get(entry.id) ?? entry.defaultKeys;
    return {
      ...entry,
      keys: resolved,
      keyLabels: resolved.map(formatKeyChord),
      publicToExtensions: false,
      isEnabled: () => enabled(entry.id),
      match: matchesAnyKeyChord(resolved),
      run: handlers[entry.id],
    };
  });
}
