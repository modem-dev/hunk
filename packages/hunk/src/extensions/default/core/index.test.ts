import { describe, expect, test } from "bun:test";
import { retireExtensionLoadResult } from "../../events";
import { loadBundledCoreExtensions } from ".";

describe("bundled core extension registry", () => {
  test("loads the GitHub command through the public extension path", async () => {
    const loaded = loadBundledCoreExtensions("/repo");

    expect(loaded.registry.extensions).toEqual([
      { id: "hunk", sourcePath: "hunk:bundled/gh", origin: "bundled" },
    ]);
    expect(loaded.registry.cliCommands.map((entry) => entry.command)).toEqual([
      {
        name: "gh",
        summary: "Review GitHub pull requests, commits, and comparisons",
        usage: "<pr|commit|compare> <target> [--repo <owner/repo>]",
      },
    ]);
    expect(loaded.registry.cliCommands[0]?.extensionId).toBe("hunk");
    expect(loaded.registry.eventHandlers.shutdown).toHaveLength(1);

    await retireExtensionLoadResult(loaded);
    expect(loaded.registry.eventBusPhase).toBe("closed");
  });

  test("returns a fresh lifecycle-owned registry for each session", async () => {
    const first = loadBundledCoreExtensions("/one");
    const second = loadBundledCoreExtensions("/two");

    expect(first.registry).not.toBe(second.registry);
    expect(first.context.cwd).toBe("/one");
    expect(second.context.cwd).toBe("/two");

    await Promise.all([retireExtensionLoadResult(first), retireExtensionLoadResult(second)]);
  });
});
