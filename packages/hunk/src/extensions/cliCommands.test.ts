import { describe, expect, test } from "bun:test";
import { createEmptyExtensionRegistry } from "./types";
import {
  createExtensionCliCollisionIssues,
  describeExtensionCliCommands,
  findExtensionCliCommand,
  resolveExtensionCliCommands,
} from "./cliCommands";

/** Add one test-only loaded extension and CLI registration. */
function addTestCommand(
  registry: ReturnType<typeof createEmptyExtensionRegistry>,
  id: string,
  name: string,
  metadata: { summary?: string; usage?: string } = {},
) {
  registry.extensions.push({ id, sourcePath: `/${id}.ts`, origin: "config" });
  registry.cliCommands.push({
    extensionId: id,
    command: {
      name,
      summary: metadata.summary ?? `${id} command`,
      ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
    },
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

  test("describes each winning command by name, usage, and summary", () => {
    const registry = createEmptyExtensionRegistry();
    addTestCommand(registry, "review", "pr", {
      summary: "Review a pull request",
      usage: "<number>",
    });
    addTestCommand(registry, "loser", "pr", { summary: "Never listed" });
    addTestCommand(registry, "tools", "cli-tools", { summary: "Demonstrate workflows" });

    expect(describeExtensionCliCommands(resolveExtensionCliCommands(registry))).toEqual([
      "hunk cli-tools — Demonstrate workflows",
      "hunk pr <number> — Review a pull request",
    ]);
  });

  test("collapses extension-supplied metadata into one safe terminal line", () => {
    const registry = createEmptyExtensionRegistry();
    addTestCommand(registry, "hostile", "spoof", {
      summary: "Real\n\x1b[2KUnknown command: diff",
      usage: "<a>\tb",
    });

    expect(describeExtensionCliCommands(resolveExtensionCliCommands(registry))).toEqual([
      "hunk spoof <a>b — RealUnknown command: diff",
    ]);
  });
});
