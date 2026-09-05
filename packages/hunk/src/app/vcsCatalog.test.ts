import { describe, expect, test } from "bun:test";
import { createVcsCatalog, extendVcsCatalog, getDefaultVcsAdapter } from "../core/vcs";
import type { VcsAdapter } from "../core/vcs/types";
import {
  loadBundledExtensionPackages,
  reservedVcsIdsForBundledPackages,
  type BundledExtensionPackage,
} from "../extensions/bundledPackages";
import { getBundledVcsCatalog } from "./vcsCatalog";

describe("app VCS catalog composition", () => {
  test("owns bundled ordering, fallback, and reserved ids at the app boundary", () => {
    const catalog = getBundledVcsCatalog();

    expect(catalog.defaultAdapterId).toBe("git");
    expect(catalog.adapters.map((adapter) => adapter.id)).toEqual(["jj", "sl", "git"]);
    expect(catalog.reservedIds).toEqual(new Set(["jj", "sl", "git"]));
  });

  test("reserves descriptor VCS ids when a bundled factory fails", () => {
    const failingGitPackage: BundledExtensionPackage = {
      packageId: "@hunk/git-test",
      packageName: "@hunk/git-test",
      packageVersion: "0.0.0",
      reservedVcsIds: ["git"],
      entries: [
        {
          id: "git",
          factory: () => {
            throw new Error("broken fixture");
          },
        },
      ],
    };
    const loaded = loadBundledExtensionPackages([failingGitPackage]);
    const catalog = createVcsCatalog(
      loaded.registry.vcsAdapters.map((entry) => entry.adapter),
      "git",
      reservedVcsIdsForBundledPackages([failingGitPackage]),
    );
    const userGit = { id: "git" } as VcsAdapter;

    expect(loaded.issues).toHaveLength(1);
    expect(extendVcsCatalog(catalog, [userGit]).adapters).toEqual([]);
    expect(() => getDefaultVcsAdapter(catalog)).toThrow("default git backend failed to load");
  });
});
