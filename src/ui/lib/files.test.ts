import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { buildSidebarEntries, fileLabelParts } from "./files";

describe("files helpers", () => {
  test("buildSidebarEntries hides zero-value sidebar stats", () => {
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

    const entries = buildSidebarEntries([onlyAdd, onlyRemove, renamedWithoutContentChanges]).filter(
      (entry) => entry.kind === "file",
    );

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

  test("buildSidebarEntries includes compact per-file comment counts before diff stats", () => {
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

    const [entry] = buildSidebarEntries([withComments]).filter((item) => item.kind === "file");

    expect(entry).toMatchObject({
      name: "commented.ts",
      agentCommentsText: "*3",
      additionsText: "+2",
      deletionsText: "-2",
    });
  });

  test("buildSidebarEntries counts all comments attached to a file, even off-range ones", () => {
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

    const [entry] = buildSidebarEntries([withComments]).filter((item) => item.kind === "file");

    expect(entry).toMatchObject({
      name: "all-comments.ts",
      agentCommentsText: "*3",
      additionsText: "+2",
      deletionsText: "-2",
    });
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
