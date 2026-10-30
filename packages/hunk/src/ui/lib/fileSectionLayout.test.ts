import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/changeset/model";
import {
  buildFileSectionLayouts,
  collectIntersectingFileSectionIds,
  findFileSectionAtOffset,
  type FileSectionLayout,
} from "./fileSectionLayout";

const layouts: FileSectionLayout[] = [
  {
    fileId: "alpha",
    sectionIndex: 0,
    sectionTop: 0,
    headerTop: 0,
    bodyTop: 0,
    bodyHeight: 5,
    sectionBottom: 5,
  },
  {
    fileId: "beta",
    sectionIndex: 1,
    sectionTop: 5,
    headerTop: 6,
    bodyTop: 7,
    bodyHeight: 4,
    sectionBottom: 11,
  },
  {
    fileId: "gamma",
    sectionIndex: 2,
    sectionTop: 11,
    headerTop: 12,
    bodyTop: 13,
    bodyHeight: 6,
    sectionBottom: 19,
  },
];

describe("fileSectionLayout helpers", () => {
  test("findFileSectionAtOffset returns the containing section and clamps past the ends", () => {
    expect(findFileSectionAtOffset([], 3)).toBeNull();
    expect(findFileSectionAtOffset(layouts, -5)?.fileId).toBe("alpha");
    expect(findFileSectionAtOffset(layouts, 4)?.fileId).toBe("alpha");
    expect(findFileSectionAtOffset(layouts, 5)?.fileId).toBe("beta");
    expect(findFileSectionAtOffset(layouts, 10)?.fileId).toBe("beta");
    expect(findFileSectionAtOffset(layouts, 11)?.fileId).toBe("gamma");
    expect(findFileSectionAtOffset(layouts, 99)?.fileId).toBe("gamma");
  });

  test("collectIntersectingFileSectionIds returns every file whose section overlaps the range", () => {
    expect(Array.from(collectIntersectingFileSectionIds(layouts, 6, 10))).toEqual(["beta"]);
    expect(Array.from(collectIntersectingFileSectionIds(layouts, 4, 12))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(Array.from(collectIntersectingFileSectionIds(layouts, 20, 24))).toEqual([]);
    expect(Array.from(collectIntersectingFileSectionIds(layouts, 10, 6))).toEqual([]);
  });

  test("collectIntersectingFileSectionIds handles large ordered layout lists", () => {
    const manyLayouts: FileSectionLayout[] = Array.from({ length: 10_000 }, (_, index) => ({
      fileId: `file:${index}`,
      sectionIndex: index,
      sectionTop: index * 3,
      headerTop: index * 3,
      bodyTop: index * 3,
      bodyHeight: 2,
      sectionBottom: index * 3 + 2,
    }));

    expect(Array.from(collectIntersectingFileSectionIds(manyLayouts, 15_000, 15_006))).toEqual([
      "file:5000",
      "file:5001",
      "file:5002",
    ]);
  });

  test("file gap 0, 1, and 3 shift later section offsets and keep the first file flush", () => {
    const files = [{ id: "a" }, { id: "b" }] as DiffFile[];
    const bodyHeights = [5, 4];

    const gap0 = buildFileSectionLayouts(files, bodyHeights, undefined, 0);
    expect(gap0[0]?.sectionTop).toBe(0);
    expect(gap0[0]?.headerTop).toBe(0);
    expect(gap0[0]?.bodyTop).toBe(0);
    expect(gap0[1]?.sectionTop).toBe(5);
    expect(gap0[1]?.headerTop).toBe(5);
    expect(gap0[1]?.bodyTop).toBe(6);

    const gap1 = buildFileSectionLayouts(files, bodyHeights, undefined, 1);
    expect(gap1[1]?.sectionTop).toBe(5);
    expect(gap1[1]?.headerTop).toBe(6);
    expect(gap1[1]?.bodyTop).toBe(7);

    const gap3 = buildFileSectionLayouts(files, bodyHeights, undefined, 3);
    expect(gap3[1]?.sectionTop).toBe(5);
    expect(gap3[1]?.headerTop).toBe(8);
    expect(gap3[1]?.bodyTop).toBe(9);
    expect(gap3[1]?.sectionBottom).toBe(13);
  });
});
