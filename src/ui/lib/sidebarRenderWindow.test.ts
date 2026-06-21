import { describe, expect, test } from "bun:test";
import type { SidebarEntry } from "./files";
import { buildSidebarRenderWindow, type SidebarRenderWindowItem } from "./sidebarRenderWindow";

/** Build fixed-height sidebar rows with occasional group headers. */
function createEntries(ids: string[]): SidebarEntry[] {
  return ids.map((id) =>
    id.startsWith("group:")
      ? { kind: "group", id, label: `${id.slice("group:".length)}/` }
      : {
          kind: "file",
          id,
          name: `${id}.ts`,
          agentCommentsText: null,
          additionsText: null,
          deletionsText: null,
          changeType: "change",
          isUntracked: false,
          collapsed: false,
        },
  );
}

/** Sum mounted row and spacer heights from a sidebar render-window plan. */
function renderedHeight(items: SidebarRenderWindowItem[]) {
  return items.reduce((total, item) => total + (item.kind === "spacer" ? item.height : 1), 0);
}

/** Return a compact item shape for assertions. */
function itemSummary(items: SidebarRenderWindowItem[]) {
  return items.map((item) =>
    item.kind === "spacer"
      ? {
          kind: "spacer",
          height: item.height,
          startIndex: item.startIndex,
          endIndex: item.endIndex,
        }
      : { kind: "entry", entryIndex: item.entryIndex, id: item.entry.id },
  );
}

describe("buildSidebarRenderWindow", () => {
  test("returns an empty plan when there are no rows", () => {
    const plan = buildSidebarRenderWindow({ entries: [], scrollTop: 0, viewportHeight: 10 });

    expect(plan.items).toEqual([]);
    expect(plan.mountedEntryIndices).toEqual([]);
    expect(plan.visibleStartIndex).toBeNull();
    expect(plan.visibleEndIndex).toBeNull();
    expect(plan.topSpacerHeight).toBe(0);
    expect(plan.bottomSpacerHeight).toBe(0);
  });

  test("mounts the first viewport and reserves the rest in a bottom spacer", () => {
    const entries = createEntries(["file-0", "file-1", "file-2", "file-3", "file-4"]);
    const plan = buildSidebarRenderWindow({
      entries,
      overscanRows: 0,
      scrollTop: 0,
      viewportHeight: 3,
    });

    expect(plan.mountedEntryIndices).toEqual([0, 1, 2]);
    expect(plan.visibleStartIndex).toBe(0);
    expect(plan.visibleEndIndex).toBe(2);
    expect(plan.topSpacerHeight).toBe(0);
    expect(plan.bottomSpacerHeight).toBe(2);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "entry", entryIndex: 0, id: "file-0" },
      { kind: "entry", entryIndex: 1, id: "file-1" },
      { kind: "entry", entryIndex: 2, id: "file-2" },
      { kind: "spacer", height: 2, startIndex: 3, endIndex: 4 },
    ]);
    expect(renderedHeight(plan.items)).toBe(entries.length);
  });

  test("clamps overscan at the last viewport", () => {
    const entries = createEntries(["file-0", "file-1", "file-2", "file-3", "file-4"]);
    const plan = buildSidebarRenderWindow({
      entries,
      overscanRows: 1,
      scrollTop: 3,
      viewportHeight: 2,
    });

    expect(plan.mountedEntryIndices).toEqual([2, 3, 4]);
    expect(plan.visibleStartIndex).toBe(3);
    expect(plan.visibleEndIndex).toBe(4);
    expect(plan.topSpacerHeight).toBe(2);
    expect(plan.bottomSpacerHeight).toBe(0);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "spacer", height: 2, startIndex: 0, endIndex: 1 },
      { kind: "entry", entryIndex: 2, id: "file-2" },
      { kind: "entry", entryIndex: 3, id: "file-3" },
      { kind: "entry", entryIndex: 4, id: "file-4" },
    ]);
    expect(renderedHeight(plan.items)).toBe(entries.length);
  });

  test("adds row-level overscan around the visible range", () => {
    const entries = createEntries(["file-0", "file-1", "file-2", "file-3", "file-4", "file-5"]);
    const plan = buildSidebarRenderWindow({
      entries,
      overscanRows: 2,
      scrollTop: 2,
      viewportHeight: 1,
    });

    expect(plan.visibleStartIndex).toBe(2);
    expect(plan.visibleEndIndex).toBe(2);
    expect(plan.mountedEntryIndices).toEqual([0, 1, 2, 3, 4]);
    expect(plan.bottomSpacerHeight).toBe(1);
    expect(renderedHeight(plan.items)).toBe(entries.length);
  });

  test("keeps a selected file outside the viewport mounted as a sparse island", () => {
    const entries = createEntries(["file-0", "file-1", "file-2", "file-3", "file-4"]);
    const plan = buildSidebarRenderWindow({
      entries,
      overscanRows: 0,
      scrollTop: 0,
      selectedFileId: "file-4",
      viewportHeight: 2,
    });

    expect(plan.mountedEntryIndices).toEqual([0, 1, 4]);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "entry", entryIndex: 0, id: "file-0" },
      { kind: "entry", entryIndex: 1, id: "file-1" },
      { kind: "spacer", height: 2, startIndex: 2, endIndex: 3 },
      { kind: "entry", entryIndex: 4, id: "file-4" },
    ]);
    expect(renderedHeight(plan.items)).toBe(entries.length);
  });

  test("uses the filtered entry list and ignores a selected file that is filtered out", () => {
    const entries = createEntries(["group:src", "file-1", "file-3"]);
    const plan = buildSidebarRenderWindow({
      entries,
      overscanRows: 0,
      scrollTop: 0,
      selectedFileId: "file-9",
      viewportHeight: 2,
    });

    expect(plan.mountedEntryIndices).toEqual([0, 1]);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "entry", entryIndex: 0, id: "group:src" },
      { kind: "entry", entryIndex: 1, id: "file-1" },
      { kind: "spacer", height: 1, startIndex: 2, endIndex: 2 },
    ]);
    expect(renderedHeight(plan.items)).toBe(entries.length);
  });

  test("preserves sparse islands and spacers around group and file rows", () => {
    const entries = createEntries([
      "group:src",
      "file-0",
      "file-1",
      "group:test",
      "file-2",
      "file-3",
      "file-4",
    ]);
    const plan = buildSidebarRenderWindow({
      entries,
      overscanRows: 0,
      scrollTop: 1,
      selectedFileId: "file-4",
      viewportHeight: 1,
    });

    expect(plan.mountedEntryIndices).toEqual([1, 6]);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "spacer", height: 1, startIndex: 0, endIndex: 0 },
      { kind: "entry", entryIndex: 1, id: "file-0" },
      { kind: "spacer", height: 4, startIndex: 2, endIndex: 5 },
      { kind: "entry", entryIndex: 6, id: "file-4" },
    ]);
    expect(plan.topSpacerHeight).toBe(1);
    expect(renderedHeight(plan.items)).toBe(entries.length);
  });

  test("preserves total height as one spacer when the viewport is beyond the rows", () => {
    const entries = createEntries(["file-0", "file-1"]);
    const plan = buildSidebarRenderWindow({
      entries,
      overscanRows: 0,
      scrollTop: 99,
      viewportHeight: 10,
    });

    expect(plan.mountedEntryIndices).toEqual([]);
    expect(plan.visibleStartIndex).toBeNull();
    expect(plan.visibleEndIndex).toBeNull();
    expect(itemSummary(plan.items)).toEqual([
      { kind: "spacer", height: 2, startIndex: 0, endIndex: 1 },
    ]);
    expect(plan.topSpacerHeight).toBe(2);
    expect(plan.bottomSpacerHeight).toBe(2);
    expect(renderedHeight(plan.items)).toBe(entries.length);
  });
});
