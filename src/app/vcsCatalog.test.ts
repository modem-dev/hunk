import { describe, expect, test } from "bun:test";
import { createSessionVcsCatalog, getBundledVcsCatalog } from "./vcsCatalog";
import type { VcsAdapter } from "../core/vcs/types";

describe("app VCS catalog composition", () => {
  test("owns bundled ordering, fallback, and reserved ids at the app boundary", () => {
    const catalog = getBundledVcsCatalog();

    expect(catalog.defaultAdapterId).toBe("git");
    expect(catalog.adapters.map((adapter) => adapter.id)).toEqual(["jj", "sl", "git"]);
    expect(catalog.reservedIds).toEqual(new Set(["jj", "sl", "git"]));
  });

  test("adds user adapters without allowing bundled ids to be replaced", () => {
    const hg: VcsAdapter = {
      id: "hg",
      name: "Mercurial",
      detect: () => null,
      operations: {},
    };
    const fakeGit = { ...hg, id: "git" };
    const catalog = createSessionVcsCatalog([fakeGit, hg]);

    expect(catalog.adapters.map((adapter) => adapter.id)).toEqual(["jj", "sl", "git", "hg"]);
  });
});
