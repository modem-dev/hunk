import { describe, expect, test } from "bun:test";
import {
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
});
