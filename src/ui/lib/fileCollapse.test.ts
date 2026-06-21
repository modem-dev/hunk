import { describe, expect, it } from "bun:test";
import type { DiffFile, NoiseKind } from "../../core/types";
import { collapsedFileVariant, resolveCollapsedFileIds } from "./fileCollapse";

/** Minimal DiffFile stub carrying only what the collapse policy reads. */
function createFile(id: string, noiseKind?: NoiseKind): DiffFile {
  return {
    id,
    path: `${id}.ts`,
    patch: "",
    stats: { additions: 3, deletions: 1 },
    metadata: {
      name: `${id}.ts`,
      type: "change",
      hunks: [{ id: 1 } as never],
      splitLineCount: 0,
      unifiedLineCount: 0,
      isPartial: false,
      additionLines: [],
      deletionLines: [],
      cacheKey: id,
    },
    agent: null,
    noiseKind,
  };
}

const EMPTY: ReadonlySet<string> = new Set();

describe("resolveCollapsedFileIds", () => {
  it("collapses noise files by default and leaves ordinary files expanded", () => {
    const files = [createFile("a"), createFile("lock", "lockfile"), createFile("b")];
    const collapsed = resolveCollapsedFileIds({
      files,
      collapseGenerated: true,
      manuallyCollapsedFileIds: EMPTY,
      manuallyExpandedFileIds: EMPTY,
    });
    expect([...collapsed]).toEqual(["lock"]);
  });

  it("does not collapse noise files when the policy is disabled", () => {
    const files = [createFile("lock", "lockfile")];
    const collapsed = resolveCollapsedFileIds({
      files,
      collapseGenerated: false,
      manuallyCollapsedFileIds: EMPTY,
      manuallyExpandedFileIds: EMPTY,
    });
    expect(collapsed.size).toBe(0);
  });

  it("lets an explicit expand override the noise default", () => {
    const files = [createFile("lock", "lockfile")];
    const collapsed = resolveCollapsedFileIds({
      files,
      collapseGenerated: true,
      manuallyCollapsedFileIds: EMPTY,
      manuallyExpandedFileIds: new Set(["lock"]),
    });
    expect(collapsed.size).toBe(0);
  });

  it("lets an explicit collapse hide an ordinary file", () => {
    const files = [createFile("a")];
    const collapsed = resolveCollapsedFileIds({
      files,
      collapseGenerated: true,
      manuallyCollapsedFileIds: new Set(["a"]),
      manuallyExpandedFileIds: EMPTY,
    });
    expect([...collapsed]).toEqual(["a"]);
  });
});

describe("collapsedFileVariant", () => {
  it("swaps hunks for an empty placeholder while preserving identity and stats", () => {
    const file = createFile("lock", "lockfile");
    const variant = collapsedFileVariant(file);
    expect(variant.id).toBe(file.id);
    expect(variant.noiseKind).toBe("lockfile");
    expect(variant.stats).toEqual(file.stats);
    expect(variant.metadata.hunks).toHaveLength(0);
    expect(variant.isCollapsedPlaceholder).toBe(true);
  });

  it("returns a stable variant object for the same source file", () => {
    const file = createFile("lock", "lockfile");
    expect(collapsedFileVariant(file)).toBe(collapsedFileVariant(file));
  });
});
