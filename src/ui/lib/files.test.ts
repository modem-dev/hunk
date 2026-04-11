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
      additionsText: "+5",
      deletionsText: null,
    });
    expect(entries[1]).toMatchObject({
      name: "only-remove.ts",
      additionsText: null,
      deletionsText: "-3",
    });
    expect(entries[2]).toMatchObject({
      name: "Legacy.tsx -> Renamed.tsx",
      additionsText: null,
      deletionsText: null,
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
