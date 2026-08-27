import type {
  ExtensionCliCommand,
  ExtensionLoadIssue,
  ExtensionRegistry,
  RegisteredCliCommand,
} from "./types";

export interface ExtensionCliCommandCollision {
  name: string;
  winnerExtensionId: string;
  rejectedExtensionId: string;
}

export interface ResolvedExtensionCliCommands {
  commands: ReadonlyMap<string, RegisteredCliCommand>;
  collisions: readonly ExtensionCliCommandCollision[];
}

/** Resolve top-level CLI ownership in registry order without mutating registrations. */
export function resolveExtensionCliCommands(
  registry: ExtensionRegistry,
): ResolvedExtensionCliCommands {
  const commands = new Map<string, RegisteredCliCommand>();
  const collisions: ExtensionCliCommandCollision[] = [];

  for (const registered of registry.cliCommands) {
    const winner = commands.get(registered.command.name);
    if (!winner) {
      commands.set(registered.command.name, registered);
      continue;
    }
    collisions.push({
      name: registered.command.name,
      winnerExtensionId: winner.extensionId,
      rejectedExtensionId: registered.extensionId,
    });
  }

  return Object.freeze({
    commands: commands as ReadonlyMap<string, RegisteredCliCommand>,
    collisions: Object.freeze(collisions),
  });
}

/** Find the extension handler that owns one exact top-level token. */
export function findExtensionCliCommand(name: string, resolved: ResolvedExtensionCliCommands) {
  return resolved.commands.get(name);
}

/** Convert duplicate command claims into sanitized extension load issues. */
export function createExtensionCliCollisionIssues(
  registry: ExtensionRegistry,
  collisions: readonly ExtensionCliCommandCollision[],
): ExtensionLoadIssue[] {
  return collisions.flatMap((collision) => {
    const rejected = registry.extensions.find(
      (extension) => extension.id === collision.rejectedExtensionId,
    );
    if (!rejected) return [];
    return [
      {
        extensionId: rejected.id,
        path: rejected.sourcePath,
        origin: rejected.origin,
        message:
          `CLI command "${collision.name}" is already registered by ` +
          `${collision.winnerExtensionId}; ${collision.rejectedExtensionId} cannot replace it.`,
      },
    ];
  });
}

/** Copy public command metadata before storing it in the host registry. */
export function copyExtensionCliCommand(command: ExtensionCliCommand): ExtensionCliCommand {
  return {
    name: command.name,
    summary: command.summary,
    ...(command.usage === undefined ? {} : { usage: command.usage }),
  };
}
