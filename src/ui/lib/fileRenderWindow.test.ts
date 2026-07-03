import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/types";
import { buildFileSectionLayouts } from "./fileSectionLayout";
import { buildFileRenderWindow, type FileRenderWindowItem } from "./fileRenderWindow";

/** Build simple file-section layouts with realistic separator/header rows after the first file. */
function createLayouts(count: number, bodyHeight = 10) {
  const files = Array.from({ length: count }, (_, index) => ({
    id: `file-${index}`,
  })) as DiffFile[];
  return buildFileSectionLayouts(
    files,
    Array.from({ length: count }, () => bodyHeight),
  );
}

/** Sum exact rendered item heights using the source section layouts for file items. */
function renderedHeight(items: FileRenderWindowItem[], layouts: ReturnType<typeof createLayouts>) {
  return items.reduce((total, item) => {
    if (item.kind === "spacer") {
      return total + item.height;
    }

    const layout = layouts[item.sectionIndex]!;
    return total + (layout.sectionBottom - layout.sectionTop);
  }, 0);
}

/** Return a compact item shape for assertions. */
function itemSummary(items: FileRenderWindowItem[]) {
  return items.map((item) =>
    item.kind === "spacer"
      ? {
          kind: "spacer",
          height: item.height,
          startIndex: item.startIndex,
          endIndex: item.endIndex,
        }
      : { kind: "file", sectionIndex: item.sectionIndex },
  );
}

describe("buildFileRenderWindow", () => {
  test("returns an empty plan when there are no files", () => {
    const plan = buildFileRenderWindow({
      fileSectionLayouts: [],
      scrollTop: 0,
      viewportHeight: 10,
    });

    expect(plan.items).toEqual([]);
    expect(plan.mountedFileIndices).toEqual([]);
    expect(plan.visibleStartIndex).toBeNull();
    expect(plan.visibleEndIndex).toBeNull();
    expect(plan.topSpacerHeight).toBe(0);
    expect(plan.bottomSpacerHeight).toBe(0);
  });

  test("mounts the visible first file and reserves the rest in one bottom spacer", () => {
    const layouts = createLayouts(4);
    const plan = buildFileRenderWindow({
      fileSectionLayouts: layouts,
      overscanFiles: 0,
      scrollTop: 0,
      viewportHeight: 5,
    });

    expect(plan.mountedFileIndices).toEqual([0]);
    expect(plan.visibleStartIndex).toBe(0);
    expect(plan.visibleEndIndex).toBe(0);
    expect(plan.topSpacerHeight).toBe(0);
    expect(plan.bottomSpacerHeight).toBe(36);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "file", sectionIndex: 0 },
      { kind: "spacer", height: 36, startIndex: 1, endIndex: 3 },
    ]);
    expect(renderedHeight(plan.items, layouts)).toBe(layouts.at(-1)!.sectionBottom);
  });

  test("adds file-level overscan around the visible range with exact top and bottom spacers", () => {
    const layouts = createLayouts(5);
    const plan = buildFileRenderWindow({
      fileSectionLayouts: layouts,
      overscanFiles: 1,
      scrollTop: layouts[2]!.bodyTop,
      viewportHeight: 3,
    });

    expect(plan.mountedFileIndices).toEqual([1, 2, 3]);
    expect(plan.visibleStartIndex).toBe(2);
    expect(plan.visibleEndIndex).toBe(2);
    expect(plan.topSpacerHeight).toBe(10);
    expect(plan.bottomSpacerHeight).toBe(12);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "spacer", height: 10, startIndex: 0, endIndex: 0 },
      { kind: "file", sectionIndex: 1 },
      { kind: "file", sectionIndex: 2 },
      { kind: "file", sectionIndex: 3 },
      { kind: "spacer", height: 12, startIndex: 4, endIndex: 4 },
    ]);
    expect(renderedHeight(plan.items, layouts)).toBe(layouts.at(-1)!.sectionBottom);
  });

  test("keeps a selected file outside the viewport mounted without filling the gap", () => {
    const layouts = createLayouts(5);
    const plan = buildFileRenderWindow({
      fileSectionLayouts: layouts,
      overscanFiles: 0,
      scrollTop: 0,
      selectedFileId: "file-4",
      viewportHeight: 4,
    });

    expect(plan.mountedFileIndices).toEqual([0, 4]);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "file", sectionIndex: 0 },
      { kind: "spacer", height: 36, startIndex: 1, endIndex: 3 },
      { kind: "file", sectionIndex: 4 },
    ]);
    expect(renderedHeight(plan.items, layouts)).toBe(layouts.at(-1)!.sectionBottom);
  });

  test("mounts explicitly included prefetch files as sparse islands", () => {
    const layouts = createLayouts(6);
    const plan = buildFileRenderWindow({
      fileSectionLayouts: layouts,
      includeFileIds: ["file-5"],
      overscanFiles: 0,
      scrollTop: layouts[2]!.bodyTop,
      viewportHeight: 2,
    });

    expect(plan.mountedFileIndices).toEqual([2, 5]);
    expect(itemSummary(plan.items)).toEqual([
      { kind: "spacer", height: 22, startIndex: 0, endIndex: 1 },
      { kind: "file", sectionIndex: 2 },
      { kind: "spacer", height: 24, startIndex: 3, endIndex: 4 },
      { kind: "file", sectionIndex: 5 },
    ]);
    expect(renderedHeight(plan.items, layouts)).toBe(layouts.at(-1)!.sectionBottom);
  });

  test("clamps overscan at the last file", () => {
    const layouts = createLayouts(3);
    const plan = buildFileRenderWindow({
      fileSectionLayouts: layouts,
      overscanFiles: 2,
      scrollTop: layouts[2]!.bodyTop,
      viewportHeight: 3,
    });

    expect(plan.mountedFileIndices).toEqual([0, 1, 2]);
    expect(plan.topSpacerHeight).toBe(0);
    expect(plan.bottomSpacerHeight).toBe(0);
    expect(renderedHeight(plan.items, layouts)).toBe(layouts.at(-1)!.sectionBottom);
  });

  test("preserves total height as one spacer when the viewport is beyond the stream", () => {
    const layouts = createLayouts(2);
    const plan = buildFileRenderWindow({
      fileSectionLayouts: layouts,
      overscanFiles: 0,
      scrollTop: 999,
      viewportHeight: 10,
    });

    expect(plan.mountedFileIndices).toEqual([]);
    expect(plan.visibleStartIndex).toBeNull();
    expect(plan.visibleEndIndex).toBeNull();
    expect(itemSummary(plan.items)).toEqual([
      { kind: "spacer", height: 22, startIndex: 0, endIndex: 1 },
    ]);
    expect(plan.topSpacerHeight).toBe(22);
    expect(plan.bottomSpacerHeight).toBe(22);
    expect(renderedHeight(plan.items, layouts)).toBe(layouts.at(-1)!.sectionBottom);
  });
});
