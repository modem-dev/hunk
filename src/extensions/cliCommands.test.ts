import { describe, expect, test } from "bun:test";
import { createEmptyExtensionRegistry } from "./types";
import {
  createExtensionCliCollisionIssues,
  findExtensionCliCommand,
  resolveExtensionCliCommands,
} from "./cliCommands";

/** Add one test-only loaded extension and CLI registration. */
function addTestCommand(
  registry: ReturnType<typeof createEmptyExtensionRegistry>,
  id: string,
  name: string,
) {
  registry.extensions.push({ id, sourcePath: `/${id}.ts`, origin: "config" });
  registry.cliCommands.push({
    extensionId: id,
    command: { name, summary: `${id} command` },
    handler: () => ({ kind: "exit" }),
  });
}

describe("extension CLI command resolution", () => {
  test("keeps the first command claim in registry order", () => {
    const registry = createEmptyExtensionRegistry();
    addTestCommand(registry, "first", "pr");
    addTestCommand(registry, "second", "pr");

    const resolved = resolveExtensionCliCommands(registry);

    expect(findExtensionCliCommand("pr", resolved)?.extensionId).toBe("first");
    expect(findExtensionCliCommand("PR", resolved)).toBeUndefined();
    expect(resolved.collisions).toEqual([
      { name: "pr", winnerExtensionId: "first", rejectedExtensionId: "second" },
    ]);
    expect(createExtensionCliCollisionIssues(registry, resolved.collisions)[0]?.message).toContain(
      'CLI command "pr" is already registered by first',
    );
  });
});
