import { describe, expect, test } from "bun:test";
import type { BrowserReviewDocument, BrowserReviewFile } from "./reviewTypes";
import {
  buildReviewPathMap,
  buildReviewTreeIdentities,
  createReviewTreeSource,
} from "./treeSource";

function file(
  key: string,
  path: string,
  changeKind: BrowserReviewFile["changeKind"] = "change",
): BrowserReviewFile {
  return {
    key,
    runtimeId: `runtime:${key}`,
    path,
    changeKind,
    additions: 1,
    deletions: 0,
    statsTruncated: false,
    hunkCount: 0,
    flags: { untracked: false, binary: false, tooLarge: false, partial: true },
    patchResourceId: `patch:${key}`,
    canonicalResourceId: `canonical:${key}`,
    sourceResourceIds: {},
    hunks: [],
    notes: [],
  };
}

function document(generation: string, files: BrowserReviewFile[]): BrowserReviewDocument {
  return {
    version: 1,
    generation,
    documentIdentity: "document:test",
    changesetId: "changeset:test",
    title: "Review",
    sourceLabel: "test",
    files,
    resources: [],
    capabilities: { actions: [] },
  };
}

describe("Pierre tree source", () => {
  test("preserves authoritative order and maps canonical paths to semantic keys", () => {
    const files = [file("z", "z-last.ts"), file("a", "src/a-first.ts"), file("m", "middle.ts")];
    expect(Array.from(buildReviewPathMap(files))).toEqual([
      ["z-last.ts", ["z"]],
      ["src/a-first.ts", ["a"]],
      ["middle.ts", ["m"]],
    ]);
    const source = createReviewTreeSource(document("generation:1", files), [], () => {});
    expect(
      source.model
        .getVisibleRows(0, 10)
        .filter((row) => row.kind === "file")
        .map((row) => row.path),
    ).toEqual(["z-last.ts", "src/a-first.ts", "middle.ts"]);
    expect(source.model.getItem("src")?.isDirectory()).toBeTrue();
    source.model.cleanUp();
  });

  test("keeps duplicate canonical paths as distinct reachable leaves and jump targets", () => {
    const files = [file("first", "duplicate.ts"), file("second", "duplicate.ts")];
    const selected: string[] = [];
    const identities = buildReviewTreeIdentities(files);
    expect(identities.map((entry) => entry.canonicalPath)).toEqual([
      "duplicate.ts",
      "duplicate.ts",
    ]);
    expect(new Set(identities.map((entry) => entry.treePath)).size).toBe(2);
    expect(buildReviewPathMap(files).get("duplicate.ts")).toEqual(["first", "second"]);
    const source = createReviewTreeSource(document("generation:duplicates", files), [], (key) =>
      selected.push(key),
    );
    expect(source.fileKeyToPath.size).toBe(2);
    source.model.getItem(source.fileKeyToPath.get("second")!)?.select();
    expect(selected.at(-1)).toBe("second");
    source.selectFile("first");
    expect(source.model.getSelectedPaths()).toContain(source.fileKeyToPath.get("first")!);
    source.model.cleanUp();
  });

  test("resets replacement paths instead of assuming append-only order", () => {
    const source = createReviewTreeSource(
      document("generation:1", [file("a", "src/a.ts"), file("b", "src/b.ts")]),
      [],
      () => {},
    );
    const retained = source.reset(
      document("generation:2", [file("b2", "src/b.ts"), file("c", "other/c.ts", "new")]),
      [],
      "a",
    );
    expect(retained).toBe("b2");
    expect(source.pathToFileKey).toEqual(
      new Map([
        ["src/b.ts", "b2"],
        ["other/c.ts", "c"],
      ]),
    );
    expect(source.model.getItem("src/a.ts")).toBeNull();
    source.model.cleanUp();
  });
});
