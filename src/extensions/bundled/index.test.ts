import { describe, expect, test } from "bun:test";
import { getBundledVcsAdapters, loadBundledExtensions } from ".";

describe("bundled extension tier", () => {
  test("loads Jujutsu and Sapling through the public registration API", () => {
    const { registry, issues } = loadBundledExtensions();

    expect(issues).toEqual([]);
    expect(registry.extensions.map((extension) => extension.id)).toEqual(["jj", "sl"]);
    expect(registry.extensions.every((extension) => extension.origin === "bundled")).toBe(true);
    // Registered, not hand-assembled: each adapter is tagged with the bundled
    // extension that called `hunk.registerVcsAdapter`, exactly like a user one.
    expect(registry.vcsAdapters.map((entry) => [entry.extensionId, entry.adapter.id])).toEqual([
      ["jj", "jj"],
      ["sl", "sl"],
    ]);
  });

  test("normalizes bundled adapters through the same host conversion as user adapters", () => {
    for (const adapter of getBundledVcsAdapters()) {
      // The public shape leaves `operations` optional; the internal one does not.
      expect(adapter.operations).toBeDefined();
      expect(adapter.operations["working-tree-diff"]).toBeDefined();
      expect(adapter.operations["revision-show"]).toBeDefined();
      // Neither backend has a stash, so the command must report that, not crash.
      expect(adapter.operations["stash-show"]).toBeUndefined();
      expect(adapter.detectionPriority).toBeGreaterThan(0);
    }
  });

  test("loads once per process so every resolution path sees one adapter identity", () => {
    const first = loadBundledExtensions();

    expect(loadBundledExtensions()).toBe(first);
    expect(getBundledVcsAdapters()[0]).toBe(first.registry.vcsAdapters[0]?.adapter);
  });

  test("registers Jujutsu ahead of Sapling ahead of Git", () => {
    const [jj, sl] = getBundledVcsAdapters();

    expect([jj?.id, sl?.id]).toEqual(["jj", "sl"]);
    expect(jj?.detectionPriority).toBeGreaterThan(sl?.detectionPriority ?? 0);
  });
});
