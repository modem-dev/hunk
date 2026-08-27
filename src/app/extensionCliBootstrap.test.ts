import { describe, expect, test } from "bun:test";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { resolveExtensionCliBootstrap } from "./extensionCliBootstrap";
import { getBundledVcsCatalog } from "./vcsCatalog";

const invocation = {
  kind: "extension-cli" as const,
  commandName: "tools",
  args: [],
  extensionPaths: ["/tools.ts"],
  extensionsEnabled: true,
};

describe("resolveExtensionCliBootstrap", () => {
  test("reuses a provisional prefix after extension VCS root refinement", async () => {
    const loaded = createEmptyExtensionLoadResult("/repo");
    loaded.registry.extensions.push({ id: "tools", sourcePath: "/tools.ts", origin: "flag" });
    loaded.registry.vcsAdapters.push({
      extensionId: "tools",
      adapter: { id: "external", name: "External", detect: () => null, operations: {} },
    });
    loaded.registry.cliCommands.push({
      extensionId: "tools",
      command: { name: "tools", summary: "Tools" },
      handler: () => ({ kind: "exit" }),
    });
    const previousLoads: unknown[] = [];
    let configCalls = 0;

    const resolved = await resolveExtensionCliBootstrap(
      {
        input: invocation,
        cwd: "/repo",
        baseVcsCatalog: getBundledVcsCatalog(),
      },
      {
        resolveExtensionBootstrapConfigImpl: () => ({
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
          projectRoot: configCalls++ === 0 ? undefined : "/repo",
        }),
        findProjectRootCandidateImpl: () => "/repo",
        loadStartupExtensionsImpl: async (options) => {
          previousLoads.push(options.previousLoad);
          options.onProvisionalLoad?.(loaded);
          return loaded;
        },
      },
    );

    expect(configCalls).toBe(2);
    expect(previousLoads).toEqual([undefined, loaded]);
    expect(resolved.commands.commands.get("tools")?.extensionId).toBe("tools");
    expect(resolved.extensions.registry.eventBusPhase).toBe("loading");
  });

  test("reports duplicate command ownership without treating the extension as failed", async () => {
    const loaded = createEmptyExtensionLoadResult("/repo");
    for (const id of ["first", "second"]) {
      loaded.registry.extensions.push({ id, sourcePath: `/${id}.ts`, origin: "config" });
      loaded.registry.cliCommands.push({
        extensionId: id,
        command: { name: "tools", summary: id },
        handler: () => ({ kind: "exit" }),
      });
    }

    const resolved = await resolveExtensionCliBootstrap(
      {
        input: invocation,
        cwd: "/repo",
        baseVcsCatalog: getBundledVcsCatalog(),
      },
      {
        resolveExtensionBootstrapConfigImpl: () => ({
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        }),
        findProjectRootCandidateImpl: () => undefined,
        loadStartupExtensionsImpl: async (options) => {
          options.onProvisionalLoad?.(loaded);
          return loaded;
        },
      },
    );

    expect(resolved.commands.commands.get("tools")?.extensionId).toBe("first");
    expect(resolved.collisionIssues[0]?.extensionId).toBe("second");
    expect(resolved.extensions.issues).toEqual([]);
  });
});
