import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import {
  buildFlatSidebarEntries,
  buildTreeSidebarEntries,
  fileLabelParts,
  resolveFileSidebarMode,
} from "./files";

describe("files helpers", () => {
  test("buildFlatSidebarEntries hides zero-value sidebar stats", () => {
    const onlyAdd = createTestDiffFile({
      id: "only-add",
      path: "src/ui/only-add.ts",
      before: lines("export const stable = true;"),
      after: lines(
        "export const stable = true;",
        "export const add1 = 1;",
        "export const add2 = 2;",
        "export const add3 = 3;",
        "export const add4 = 4;",
        "export const add5 = 5;",
      ),
    });
    const onlyRemove = createTestDiffFile({
      id: "only-remove",
      path: "src/ui/only-remove.ts",
      before: lines(
        "export const stable = true;",
        "export const remove1 = 1;",
        "export const remove2 = 2;",
        "export const remove3 = 3;",
      ),
      after: lines("export const stable = true;"),
    });
    const renamedWithoutContentChanges = {
      ...createTestDiffFile({
        id: "rename-only",
        path: "src/ui/Renamed.tsx",
        previousPath: "src/ui/Legacy.tsx",
        before: lines("export const stable = true;"),
        after: lines("export const stable = true;"),
      }),
      stats: { additions: 0, deletions: 0 },
    };

    const entries = buildFlatSidebarEntries([
      onlyAdd,
      onlyRemove,
      renamedWithoutContentChanges,
    ]).filter((entry) => entry.kind === "file");

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      name: "only-add.ts",
      agentCommentsText: null,
      additionsText: "+5",
      deletionsText: null,
    });
    expect(entries[1]).toMatchObject({
      name: "only-remove.ts",
      agentCommentsText: null,
      additionsText: null,
      deletionsText: "-3",
    });
    expect(entries[2]).toMatchObject({
      name: "Legacy.tsx -> Renamed.tsx",
      agentCommentsText: null,
      additionsText: null,
      deletionsText: null,
    });
  });

  test("buildFlatSidebarEntries includes compact per-file comment counts before diff stats", () => {
    const withComments = createTestDiffFile({
      id: "with-comments",
      path: "src/ui/commented.ts",
      before: lines("const alpha = 1;", "const beta = 2;", "const gamma = 3;"),
      after: lines("const alpha = 10;", "const beta = 2;", "const gamma = 30;"),
      agent: {
        path: "src/ui/commented.ts",
        annotations: [
          { summary: "Note on first hunk", newRange: [1, 1] },
          { summary: "Another note on first hunk", newRange: [1, 1] },
          { summary: "Note on second hunk", newRange: [3, 3] },
        ],
      },
    });

    const [entry] = buildFlatSidebarEntries([withComments]).filter((item) => item.kind === "file");

    expect(entry).toMatchObject({
      name: "commented.ts",
      agentCommentsText: "*3",
      additionsText: "+2",
      deletionsText: "-2",
    });
  });

  test("buildFlatSidebarEntries counts all comments attached to a file, even off-range ones", () => {
    const withComments = createTestDiffFile({
      id: "all-comments",
      path: "src/ui/all-comments.ts",
      before: lines("const alpha = 1;", "const beta = 2;", "const gamma = 3;"),
      after: lines("const alpha = 10;", "const beta = 2;", "const gamma = 30;"),
      agent: {
        path: "src/ui/all-comments.ts",
        annotations: [
          { summary: "First note", newRange: [1, 1] },
          { summary: "Second note", newRange: [1, 1] },
          // The sidebar count is per-file, so even comments outside a visible hunk still count.
          { summary: "Third note", newRange: [20, 20] },
        ],
      },
    });

    const [entry] = buildFlatSidebarEntries([withComments]).filter((item) => item.kind === "file");

    expect(entry).toMatchObject({
      name: "all-comments.ts",
      agentCommentsText: "*3",
      additionsText: "+2",
      deletionsText: "-2",
    });
  });

  test("buildFlatSidebarEntries marks each root-file run with an in-place ./ group", () => {
    const files = [
      createTestDiffFile({ id: "nested-a", path: "src/a.ts" }),
      createTestDiffFile({ id: "root-a", path: "README.md" }),
      createTestDiffFile({ id: "root-b", path: "package.json" }),
      createTestDiffFile({ id: "nested-b", path: "test/b.ts" }),
      createTestDiffFile({ id: "root-c", path: "LICENSE" }),
    ];

    const labels = buildFlatSidebarEntries(files).map((entry) =>
      entry.kind === "file" ? entry.name : entry.label,
    );

    expect(labels).toEqual([
      "src/",
      "a.ts",
      "./",
      "README.md",
      "package.json",
      "test/",
      "b.ts",
      "./",
      "LICENSE",
    ]);
  });

  test("resolveFileSidebarMode switches at the preferred sidebar width", () => {
    expect(resolveFileSidebarMode(31)).toBe("flat");
    expect(resolveFileSidebarMode(32)).toBe("tree");
  });

  test("buildTreeSidebarEntries expands paths without changing file order", () => {
    const files = [
      createTestDiffFile({ id: "ui-a", path: "src/ui/a.ts" }),
      createTestDiffFile({ id: "ui-b", path: "src/ui/b.ts" }),
      createTestDiffFile({ id: "root", path: "README.md" }),
      createTestDiffFile({ id: "core", path: "src/core/c.ts" }),
      createTestDiffFile({ id: "test", path: "test/d.ts" }),
      createTestDiffFile({ id: "src-root", path: "src/e.ts" }),
    ];

    const entries = buildTreeSidebarEntries(files);
    const labels = entries.map((entry) =>
      entry.kind === "file" ? `${"  ".repeat(entry.depth)}${entry.name}` : entry.label,
    );

    expect(labels).toEqual([
      "src/",
      "ui/",
      "    a.ts",
      "    b.ts",
      "README.md",
      "src/",
      "core/",
      "    c.ts",
      "test/",
      "  d.ts",
      "src/",
      "  e.ts",
    ]);
    expect(entries.filter((entry) => entry.kind === "file").map((entry) => entry.id)).toEqual(
      files.map((file) => file.id),
    );
  });

  test("buildTreeSidebarEntries gives repeated directory branches unique row ids", () => {
    const directories = buildTreeSidebarEntries([
      createTestDiffFile({ id: "src-a", path: "src/a.ts" }),
      createTestDiffFile({ id: "root", path: "README.md" }),
      createTestDiffFile({ id: "src-b", path: "src/b.ts" }),
    ]).filter((entry) => entry.kind === "directory");

    expect(directories.map((entry) => entry.label)).toEqual(["src/", "src/"]);
    expect(new Set(directories.map((entry) => entry.id)).size).toBe(directories.length);
  });

  test("buildTreeSidebarEntries uses the current rename path and keeps the rename filename", () => {
    const renamed = createTestDiffFile({
      id: "renamed",
      path: "src/new/name.ts",
      previousPath: "legacy/old.ts",
    });

    expect(buildTreeSidebarEntries([renamed])).toEqual([
      expect.objectContaining({ kind: "directory", label: "src/", depth: 0 }),
      expect.objectContaining({ kind: "directory", label: "new/", depth: 1 }),
      expect.objectContaining({
        kind: "file",
        id: "renamed",
        name: "old.ts -> name.ts",
        depth: 2,
      }),
    ]);
  });

  test("buildTreeSidebarEntries preserves absolute and UNC-style path roots", () => {
    const entries = buildTreeSidebarEntries([
      createTestDiffFile({ id: "absolute", path: "/tmp/project/a.ts" }),
      createTestDiffFile({ id: "unc", path: "//server/share/b.ts" }),
    ]);

    expect(
      entries.map((entry) =>
        entry.kind === "file" ? { kind: entry.kind, name: entry.name } : entry.label,
      ),
    ).toEqual([
      "/",
      "tmp/",
      "project/",
      { kind: "file", name: "a.ts" },
      "//",
      "server/",
      "share/",
      { kind: "file", name: "b.ts" },
    ]);
  });

  test("file labels and sidebar entries render path tabs as fixed-width escapes", () => {
    const file = createTestDiffFile({ id: "tabbed-path", path: "src/tab\tname.ts" });

    expect(fileLabelParts(file)).toEqual({
      filename: "src/tab\\tname.ts",
      stateLabel: null,
    });
    expect(buildFlatSidebarEntries([file])).toEqual([
      { kind: "group", id: "group:src:0", label: "src/" },
      expect.objectContaining({ kind: "file", name: "tab\\tname.ts" }),
    ]);
  });

  test("fileLabelParts strips parser-added line endings from rename labels", () => {
    const renamedAcrossDirectories = {
      ...createTestDiffFile({
        id: "rename-across-dirs",
        path: "agents/pi/extensions/notify.ts",
        previousPath: "pi/extensions/loop.ts\n",
        before: lines("export const stable = true;"),
        after: lines("export const stable = true;"),
      }),
      stats: { additions: 0, deletions: 0 },
    };

    expect(fileLabelParts(renamedAcrossDirectories)).toEqual({
      filename: "pi/extensions/loop.ts -> agents/pi/extensions/notify.ts",
      stateLabel: null,
    });
  });
});
