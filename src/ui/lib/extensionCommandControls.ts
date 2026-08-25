import type {
  ExtensionCommandControls,
  ExtensionCommandExecutionOptions,
} from "../../extension-api/types";
import {
  executeAppCommandWithCount,
  findAppCommandById,
  isCommandEnabled,
  normalizeAppCommandCount,
  type AppCommand,
} from "./appCommands";

/** Validate an execution id passed by JavaScript despite the TypeScript contract. */
function requireCommandId(commandId: unknown): string {
  if (typeof commandId !== "string" || commandId.trim().length === 0) {
    throw new TypeError("Extension command controls require a non-empty command id.");
  }
  return commandId;
}

/** Read a probe id without turning malformed input into an extension failure. */
function commandIdForProbe(commandId: unknown): string | undefined {
  return typeof commandId === "string" && commandId.trim().length > 0 ? commandId : undefined;
}

/** Find one explicitly public host command in the current live command table. */
function findPublicCommand(commands: readonly AppCommand[], commandId: string) {
  const command = findAppCommandById(commands, commandId);
  return command?.id.startsWith("hunk.") && command.publicToExtensions ? command : undefined;
}

/**
 * Build live, renderer-free command controls for an extension command handler.
 *
 * The table is read for every operation so an async handler resumes against current App state.
 * Liveness prevents a handler retained across an App remount from driving callbacks owned by the
 * retired tree.
 */
export function createExtensionCommandControls({
  getCommands,
  isLive,
}: {
  getCommands: () => readonly AppCommand[];
  isLive: () => boolean;
}): ExtensionCommandControls {
  return Object.freeze({
    isEnabled(commandId: string) {
      const id = commandIdForProbe(commandId);
      if (!id || !isLive()) return false;
      const command = findPublicCommand(getCommands(), id);
      return Boolean(command && isCommandEnabled(command));
    },
    execute(commandId: string, options?: ExtensionCommandExecutionOptions) {
      const id = requireCommandId(commandId);
      // Validate before liveness and lookup so programming errors stay visible
      // even when a handler resumes after its App instance retired.
      const count = normalizeAppCommandCount(options);
      if (!isLive()) return false;
      const commands = getCommands();
      const command = findPublicCommand(commands, id);
      if (!command) return false;
      return executeAppCommandWithCount([command], command.id, count);
    },
  });
}
