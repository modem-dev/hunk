import { describe, expect, test } from "bun:test";
import {
  getBundledVcsAdapters,
  loadBundledExtensionPackages,
  loadBundledExtensions,
  type BundledExtensionPackage,
} from "./bundledPackages";
import type { ExtensionFactory } from "./types";

/** Build one test package around a deliberately untyped factory. */
function testPackage(factory: ExtensionFactory): BundledExtensionPackage {
  return {
    packageId: "test-package",
    packageName: "test-package",
    packageVersion: "1.0.0",
    reservedVcsIds: [],
    entries: [
      {
        id: "test-entry",
        factory: factory as BundledExtensionPackage["entries"][number]["factory"],
      },
    ],
  };
}

describe("bundled extension package loading", () => {
  test("rejects async factories before returning the registry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: ExtensionFactory = async (hunk) => {
      await gate;
      hunk.registerVcsAdapter({
        id: "late",
        name: "Late",
        detect: () => null,
      });
    };

    const loaded = loadBundledExtensionPackages([testPackage(factory)]);
    expect(loaded.registry.extensions).toEqual([]);
    expect(loaded.registry.vcsAdapters).toEqual([]);
    expect(loaded.issues[0]?.message).toContain("must be synchronous");

    release();
    await gate;
    await Bun.sleep(0);
    expect(loaded.registry.extensions).toEqual([]);
    expect(loaded.registry.vcsAdapters).toEqual([]);
  });

  test("revokes late custom events from rejected async factories", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: ExtensionFactory = async (hunk) => {
      await gate;
      hunk.events.emit("late-event", { unsafe: true });
    };

    const loaded = loadBundledExtensionPackages([testPackage(factory)]);
    release();
    await gate;
    await Bun.sleep(0);
    expect(loaded.registry.pendingCustomEvents).toEqual([]);
  });
});

describe("bundled extension tier", () => {
  test("loads every shipped VCS backend through the public registration API", () => {
    const { registry, issues } = loadBundledExtensions();

    expect(issues).toEqual([]);
    expect(registry.extensions.map((extension) => extension.id)).toEqual(["jj", "sl", "git"]);
    expect(registry.extensions.every((extension) => extension.origin === "bundled")).toBe(true);
    expect(registry.extensions.map((extension) => extension.package?.id)).toEqual([
      "@hunk/jj",
      "@hunk/sapling",
      "@hunk/git",
    ]);
    expect(registry.vcsAdapters.map((entry) => [entry.extensionId, entry.adapter.id])).toEqual([
      ["jj", "jj"],
      ["sl", "sl"],
      ["git", "git"],
    ]);
  });

  test("normalizes bundled adapters through the same host conversion as user adapters", () => {
    for (const adapter of getBundledVcsAdapters()) {
      expect(adapter.operations).toBeDefined();
      expect(adapter.operations["working-tree-diff"]).toBeDefined();
      expect(adapter.operations["revision-show"]).toBeDefined();
    }
  });

  test("keeps stash review to Git and stable adapter identities across resolution", () => {
    const first = loadBundledExtensions();
    const byId = new Map(getBundledVcsAdapters().map((adapter) => [adapter.id, adapter]));

    expect(byId.get("git")?.operations["stash-show"]).toBeDefined();
    expect(byId.get("jj")?.operations["stash-show"]).toBeUndefined();
    expect(byId.get("sl")?.operations["stash-show"]).toBeUndefined();
    expect(loadBundledExtensions()).toBe(first);
    expect(getBundledVcsAdapters()[0]).toBe(first.registry.vcsAdapters[0]?.adapter);
    expect(byId.get("jj")!.detectionPriority).toBeGreaterThan(byId.get("sl")!.detectionPriority!);
    expect(byId.get("sl")!.detectionPriority).toBeGreaterThan(
      byId.get("git")!.detectionPriority ?? 0,
    );
  });
});
