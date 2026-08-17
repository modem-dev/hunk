import { describe, expect, test } from "bun:test";
import type { HunkConfigResolution } from "../core/invocation/config";
import type { CliInput } from "../core/types";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { resolveConfiguredExtensions } from "./extensionBootstrap";
import { getBundledVcsCatalog } from "./vcsCatalog";

/** Build the normalized config needed before extension discovery starts. */
function createTestConfig(input: CliInput): HunkConfigResolution {
  return {
    input,
    customThemes: [],
    extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
    keybindings: {},
  };
}

describe("resolveConfiguredExtensions", () => {
  test("retires provisional authority when the loader rejects before returning it", async () => {
    const input: CliInput = { kind: "vcs", staged: false, options: { vcs: "git" } };
    const provisional = createEmptyExtensionLoadResult("/repo");
    let shutdowns = 0;
    let published = false;
    provisional.registry.eventHandlers.shutdown.push({
      extensionId: "probe",
      handler: () => {
        shutdowns += 1;
      },
    });

    await expect(
      resolveConfiguredExtensions(
        {
          runtimeInput: input,
          configured: createTestConfig(input),
          cwd: "/repo",
          baseVcsCatalog: getBundledVcsCatalog(),
          onProvisionalLoad: (result) => {
            published = result === provisional;
          },
        },
        {
          loadStartupExtensionsImpl: async (options) => {
            options.onProvisionalLoad?.(provisional);
            throw new Error("load exploded");
          },
        },
      ),
    ).rejects.toThrow("load exploded");

    expect(published).toBe(true);
    expect(provisional.registry.eventBusPhase).toBe("closed");
    expect(shutdowns).toBe(1);
  });

  test("stops before a later staged registry after the caller becomes inactive", async () => {
    const input: CliInput = { kind: "vcs", staged: false, options: { vcs: "git" } };
    const configured = createTestConfig(input);
    const provisional = createEmptyExtensionLoadResult("/repo");
    provisional.registry.vcsAdapters.push({
      extensionId: "probe",
      adapter: { id: "probe", name: "Probe", detect: () => null, operations: {} },
    });
    let active = true;
    let loads = 0;

    await expect(
      resolveConfiguredExtensions(
        {
          runtimeInput: input,
          configured,
          cwd: "/repo",
          baseVcsCatalog: getBundledVcsCatalog(),
          assertActive: () => {
            if (!active) throw new Error("caller retired");
          },
        },
        {
          findProjectRootCandidateImpl: () => "/recognized",
          loadStartupExtensionsImpl: async (options) => {
            loads += 1;
            options.onProvisionalLoad?.(provisional);
            active = false;
            return provisional;
          },
        },
      ),
    ).rejects.toThrow("caller retired");

    expect(loads).toBe(1);
    expect(provisional.registry.eventBusPhase).toBe("closed");
  });

  test("retires distinct first and second pass registries when the second loader rejects", async () => {
    const input: CliInput = { kind: "vcs", staged: false, options: { vcs: "git" } };
    const configured = createTestConfig(input);
    const first = createEmptyExtensionLoadResult("/repo");
    const second = createEmptyExtensionLoadResult("/repo");
    const shutdowns: string[] = [];
    first.registry.vcsAdapters.push({
      extensionId: "probe",
      adapter: { id: "probe", name: "Probe", detect: () => null, operations: {} },
    });
    first.registry.eventHandlers.shutdown.push({
      extensionId: "first",
      handler: () => {
        shutdowns.push("first");
      },
    });
    second.registry.eventHandlers.shutdown.push({
      extensionId: "second",
      handler: () => {
        shutdowns.push("second");
      },
    });
    let loads = 0;

    await expect(
      resolveConfiguredExtensions(
        {
          runtimeInput: input,
          configured,
          cwd: "/repo",
          baseVcsCatalog: getBundledVcsCatalog(),
        },
        {
          findProjectRootCandidateImpl: () => "/recognized",
          resolveConfiguredCliInputImpl: () => ({
            ...configured,
            projectRoot: "/recognized",
          }),
          loadStartupExtensionsImpl: async (options) => {
            loads += 1;
            const provisional = loads === 1 ? first : second;
            options.onProvisionalLoad?.(provisional);
            if (loads === 2) throw new Error("second pass exploded");
            return provisional;
          },
        },
      ),
    ).rejects.toThrow("second pass exploded");

    expect(loads).toBe(2);
    expect(first.registry.eventBusPhase).toBe("closed");
    expect(second.registry.eventBusPhase).toBe("closed");
    expect(shutdowns.sort()).toEqual(["first", "second"]);
  });
});
