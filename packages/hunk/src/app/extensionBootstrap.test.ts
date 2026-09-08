import { describe, expect, test } from "bun:test";
import type { HunkConfigResolution } from "../core/run/config";
import type { CliInput } from "../core/run/commandInputs";
import type { HunkExtensionAPI } from "../extension-api/types";
import { emitExtensionEvent, retireExtensionLoadResult } from "../extensions/events";
import { loadExtensions } from "../extensions/host";
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
  test("borrows one stateful extension instance across repeated review generations", async () => {
    const input: CliInput = { kind: "show", ref: "opaque", options: { vcs: "git" } };
    const state = { factories: 0, startups: 0, changesets: 0, shutdowns: 0 };
    const borrowed = await loadExtensions({
      candidates: [{ id: "stateful", path: "/repo/stateful.ts", origin: "flag" }],
      cwd: "/repo",
      importExtensionModuleImpl: async () => ({
        default(hunk: HunkExtensionAPI) {
          state.factories += 1;
          hunk.on("startup", () => {
            state.startups += 1;
          });
          hunk.on("changeset_loaded", () => {
            state.changesets += 1;
          });
          hunk.on("shutdown", () => {
            state.shutdowns += 1;
          });
        },
      }),
    });
    emitExtensionEvent(borrowed, "startup", { cwd: "/repo" });
    let loaderCalls = 0;

    for (let generation = 0; generation < 2; generation += 1) {
      const resolved = await resolveConfiguredExtensions(
        {
          runtimeInput: input,
          configured: createTestConfig(input),
          cwd: "/repo",
          baseVcsCatalog: getBundledVcsCatalog(),
          borrowedLoad: borrowed,
        },
        {
          loadStartupExtensionsImpl: async () => {
            loaderCalls += 1;
            throw new Error("borrowed extensions must not reload");
          },
        },
      );
      expect(resolved.extensions).toBe(borrowed);
      emitExtensionEvent(resolved.extensions, "changeset_loaded", {
        changeset: {
          id: `generation-${generation}`,
          title: "Stateful review",
          files: [],
          sourceLabel: `generation-${generation}`,
        },
      });
    }

    expect(state).toEqual({ factories: 1, startups: 1, changesets: 2, shutdowns: 0 });
    expect(loaderCalls).toBe(0);
    await retireExtensionLoadResult(borrowed);
    expect(state.shutdowns).toBe(1);
  });

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
