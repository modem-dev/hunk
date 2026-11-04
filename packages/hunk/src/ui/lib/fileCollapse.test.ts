import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { buildDiffFile } from "../../core/changeset/diffFile";
import type { DiffFile } from "../../core/changeset/model";
import { applyFileCollapse, collapsedFileVariant } from "./fileCollapse";

/** Build one real added-file diff so placeholder swaps run against parsed hunks. */
function createTestDiffFile(path: string): DiffFile {
  const patch = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    "+content",
    "",
  ].join("\n");
  const metadata = parsePatchFiles(patch)[0]!.files[0]!;
  return buildDiffFile(metadata, patch, 0, "test", null);
}

/** Apply collapse with defaults for the fields a test does not care about. */
function collapsedPaths(
  files: DiffFile[],
  options: {
    overrides?: Map<string, boolean>;
    collapseGenerated?: boolean;
    scoped?: boolean;
  } = {},
) {
  return applyFileCollapse({
    files,
    keyByFileId: new Map(files.map((file) => [file.id, file.path])),
    overrides: options.overrides ?? new Map(),
    collapseGenerated: options.collapseGenerated ?? true,
    scoped: options.scoped ?? false,
  })
    .filter((file) => file.isCollapsedPlaceholder)
    .map((file) => file.path);
}

describe("applyFileCollapse", () => {
  test("collapses generated files and leaves ordinary files open", () => {
    const files = [createTestDiffFile("bun.lock"), createTestDiffFile("src/app.ts")];

    expect(collapsedPaths(files)).toEqual(["bun.lock"]);
  });

  test("honours the configured default", () => {
    expect(collapsedPaths([createTestDiffFile("bun.lock")], { collapseGenerated: false })).toEqual(
      [],
    );
  });

  test("lets the reviewer's choice beat the default in both directions", () => {
    const files = [createTestDiffFile("bun.lock"), createTestDiffFile("src/app.ts")];
    const overrides = new Map([
      ["bun.lock", false],
      ["src/app.ts", true],
    ]);

    expect(collapsedPaths(files, { overrides })).toEqual(["src/app.ts"]);
  });

  test("keeps files with notes open by default", () => {
    const file = createTestDiffFile("bun.lock");
    const annotated: DiffFile = {
      ...file,
      agent: { path: file.path, annotations: [{ summary: "Check this" }] },
    } as DiffFile;

    expect(collapsedPaths([annotated])).toEqual([]);
  });

  test("defers to an extension presentation scope", () => {
    expect(collapsedPaths([createTestDiffFile("bun.lock")], { scoped: true })).toEqual([]);
  });

  test("never replaces a file that already has no hunks", () => {
    const file = createTestDiffFile("bun.lock");
    const hunkless: DiffFile = { ...file, metadata: { ...file.metadata, hunks: [] } };

    expect(collapsedPaths([hunkless])).toEqual([]);
  });
});

describe("collapsedFileVariant", () => {
  test("empties the hunks, keeps stats and identity, and returns a stable object", () => {
    const file = createTestDiffFile("bun.lock");
    const variant = collapsedFileVariant(file);

    expect(variant.metadata.hunks).toEqual([]);
    expect(variant.id).toBe(file.id);
    expect(variant.stats).toEqual(file.stats);
    expect(file.metadata.hunks.length).toBe(1);
    expect(collapsedFileVariant(file)).toBe(variant);
  });
});
