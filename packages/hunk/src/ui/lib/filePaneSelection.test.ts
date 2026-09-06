import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import {
  cursorFromSidebarIndex,
  filesVisuallyUnderSidebarEntry,
  sidebarIndexFromCursor,
  stepSidebarIndex,
} from "./filePaneSelection";
import { buildFlatSidebarEntries, buildTreeSidebarEntries } from "./files";

describe("file pane visual selection", () => {
  const files = [
    createTestDiffFile({ id: "ui-a", path: "src/ui/a.ts" }),
    createTestDiffFile({ id: "ui-b", path: "src/ui/b.ts" }),
    createTestDiffFile({ id: "root", path: "README.md" }),
    createTestDiffFile({ id: "core", path: "src/core/c.ts" }),
    createTestDiffFile({ id: "test", path: "test/d.ts" }),
    createTestDiffFile({ id: "src-root", path: "src/e.ts" }),
  ];

  test("tree folders collect nested visible files and stop at a sibling branch", () => {
    const entries = buildTreeSidebarEntries(files);
    const srcIndex = entries.findIndex(
      (entry) => entry.kind === "directory" && entry.path === "src",
    );

    expect(filesVisuallyUnderSidebarEntry(entries, srcIndex).map((entry) => entry.id)).toEqual([
      "ui-a",
      "ui-b",
    ]);

    const uiIndex = entries.findIndex(
      (entry) => entry.kind === "directory" && entry.path === "src/ui",
    );
    expect(filesVisuallyUnderSidebarEntry(entries, uiIndex).map((entry) => entry.id)).toEqual([
      "ui-a",
      "ui-b",
    ]);

    const secondSrc = entries.findIndex(
      (entry, index) => entry.kind === "directory" && entry.path === "src" && index > srcIndex,
    );
    expect(filesVisuallyUnderSidebarEntry(entries, secondSrc).map((entry) => entry.id)).toEqual([
      "core",
    ]);
  });

  test("flat groups collect only the files listed under that header", () => {
    const entries = buildFlatSidebarEntries(files);
    const srcUi = entries.findIndex((entry) => entry.kind === "group" && entry.path === "src/ui");
    const root = entries.findIndex((entry) => entry.kind === "group" && entry.path === ".");
    const src = entries.findIndex((entry) => entry.kind === "group" && entry.path === "src");

    expect(filesVisuallyUnderSidebarEntry(entries, srcUi).map((entry) => entry.id)).toEqual([
      "ui-a",
      "ui-b",
    ]);
    expect(filesVisuallyUnderSidebarEntry(entries, root).map((entry) => entry.id)).toEqual([
      "root",
    ]);
    expect(filesVisuallyUnderSidebarEntry(entries, src).map((entry) => entry.id)).toEqual([
      "src-root",
    ]);
  });

  test("stepping visits folder rows as well as files", () => {
    const entries = buildTreeSidebarEntries(files);
    const firstFile = entries.findIndex((entry) => entry.kind === "file");
    const previous = stepSidebarIndex(entries, firstFile, -1);

    expect(entries[previous]).toMatchObject({ kind: "directory", path: "src/ui" });
    expect(stepSidebarIndex(entries, 0, -1)).toBe(0);
    expect(stepSidebarIndex(entries, entries.length - 1, 1)).toBe(entries.length - 1);
  });

  test("folder cursors restore the same visual branch after a rebuild", () => {
    const entries = buildTreeSidebarEntries(files);
    const secondSrc = entries.findIndex(
      (entry, index) =>
        entry.kind === "directory" &&
        entry.path === "src" &&
        index >
          entries.findIndex(
            (candidate) => candidate.kind === "directory" && candidate.path === "src",
          ),
    );
    const cursor = cursorFromSidebarIndex(entries, secondSrc);

    expect(cursor).toEqual({ kind: "folder", path: "src", firstFileId: "core" });
    expect(sidebarIndexFromCursor(entries, cursor)).toBe(secondSrc);
    expect(sidebarIndexFromCursor(entries, { kind: "file", id: "root" })).toBe(
      entries.findIndex((entry) => entry.kind === "file" && entry.id === "root"),
    );
  });

  test("a stale duplicate folder cursor does not bind a different branch", () => {
    const entries = buildTreeSidebarEntries(files);
    const firstSrc = entries.findIndex(
      (entry) => entry.kind === "directory" && entry.path === "src",
    );
    const secondSrc = sidebarIndexFromCursor(entries, {
      kind: "folder",
      path: "src",
      firstFileId: "core",
    });
    expect(secondSrc).not.toBe(firstSrc);
    expect(filesVisuallyUnderSidebarEntry(entries, secondSrc).map((entry) => entry.id)).toEqual([
      "core",
    ]);
    expect(
      sidebarIndexFromCursor(entries, { kind: "folder", path: "src", firstFileId: "gone" }),
    ).toBe(entries.findIndex((entry) => entry.kind === "file"));
  });
});
