import { describe, expect, test } from "bun:test";
import { getBundledVcsAdapters, loadBundledExtensions } from ".";

describe("bundled extension tier", () => {
  test("loads every shipped VCS backend through the public registration API", () => {
    const { registry, issues } = loadBundledExtensions();

    expect(issues).toEqual([]);
    expect(registry.extensions.map((extension) => extension.id)).toEqual(["jj", "sl", "git"]);
    expect(registry.extensions.every((extension) => extension.origin === "bundled")).toBe(true);
    // Registered, not hand-assembled: each adapter is tagged with the bundled
    // extension that called `hunk.registerVcsAdapter`, exactly like a user one.
    // Git included — there are no core-registered adapters left.
    expect(registry.vcsAdapters.map((entry) => [entry.extensionId, entry.adapter.id])).toEqual([
      ["jj", "jj"],
      ["sl", "sl"],
      ["git", "git"],
    ]);
  });

  test("normalizes bundled adapters through the same host conversion as user adapters", () => {
    for (const adapter of getBundledVcsAdapters()) {
      // The public shape leaves `operations` optional; the internal one does not.
      expect(adapter.operations).toBeDefined();
      expect(adapter.operations["working-tree-diff"]).toBeDefined();
      expect(adapter.operations["revision-show"]).toBeDefined();
    }
  });

  test("keeps stash review to the one backend that has stashes", () => {
    const byId = new Map(getBundledVcsAdapters().map((adapter) => [adapter.id, adapter]));

    expect(byId.get("git")?.operations["stash-show"]).toBeDefined();
    // Neither jj nor Sapling has a stash, so the command must report that rather
    // than crash on a missing operation.
    expect(byId.get("jj")?.operations["stash-show"]).toBeUndefined();
    expect(byId.get("sl")?.operations["stash-show"]).toBeUndefined();
  });

  test("loads once per process so every resolution path sees one adapter identity", () => {
    const first = loadBundledExtensions();

    expect(loadBundledExtensions()).toBe(first);
    expect(getBundledVcsAdapters()[0]).toBe(first.registry.vcsAdapters[0]?.adapter);
  });

  test("registers Jujutsu and Sapling above the Git baseline", () => {
    const byId = new Map(
      getBundledVcsAdapters().map((adapter) => [adapter.id, adapter.detectionPriority ?? 0]),
    );

    // A colocated jj or Sapling checkout carries Git metadata too, so both must
    // outrank Git for the same directory.
    expect(byId.get("git")).toBe(0);
    expect(byId.get("sl")).toBeGreaterThan(byId.get("git")!);
    expect(byId.get("jj")).toBeGreaterThan(byId.get("sl")!);
  });
});
