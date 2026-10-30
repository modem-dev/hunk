import { describe, expect, test } from "bun:test";
import { getBundledVcsCatalog } from "./vcsCatalog";

describe("app VCS catalog composition", () => {
  test("owns bundled ordering, fallback, and reserved ids at the app boundary", () => {
    const catalog = getBundledVcsCatalog();

    expect(catalog.defaultAdapterId).toBe("git");
    expect(catalog.adapters.map((adapter) => adapter.id)).toEqual(["jj", "sl", "git"]);
    expect(catalog.reservedIds).toEqual(new Set(["jj", "sl", "git"]));
  });
});
