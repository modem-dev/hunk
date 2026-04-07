import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { measureDiffSectionGeometry } from "./diffSectionGeometry";
import { buildFileSectionLayouts, buildInStreamFileHeaderHeights } from "./fileSectionLayout";
import { findViewportCenteredHunkTarget } from "./viewportSelection";
import { resolveTheme } from "../themes";

function createWideTwoHunkFile(id: string, path: string, start = 1) {
  const beforeLines = Array.from(
    { length: 80 },
    (_, index) => `export const line${start + index} = ${start + index};`,
  );
  const afterLines = [...beforeLines];

  afterLines[0] = `export const line${start} = ${start + 1000};`;
  afterLines[59] = `export const line${start + 59} = ${start + 5900};`;

  return createTestDiffFile({
    after: lines(...afterLines),
    before: lines(...beforeLines),
    context: 3,
    id,
    path,
  });
}

function scrollTopForCenter(centerOffset: number, viewportHeight: number) {
  return Math.max(0, centerOffset - Math.max(0, Math.floor((viewportHeight - 1) / 2)));
}

describe("findViewportCenteredHunkTarget", () => {
  const theme = resolveTheme("midnight", null);

  test("switches the active file when the viewport center enters a later file", () => {
    const firstFile = createTestDiffFile({
      after: "export const alpha = 2;\n",
      before: "export const alpha = 1;\n",
      id: "first",
      path: "first.ts",
    });
    const secondFile = createWideTwoHunkFile("second", "second.ts", 100);
    const files = [firstFile, secondFile];
    const sectionGeometry = files.map((file) =>
      measureDiffSectionGeometry(file, "split", true, theme, [], 160, true, false),
    );
    const fileSectionLayouts = buildFileSectionLayouts(
      files,
      sectionGeometry.map((geometry) => geometry.bodyHeight),
      buildInStreamFileHeaderHeights(files),
    );
    const viewportHeight = 7;
    const secondFileFirstHunkTop =
      fileSectionLayouts[1]!.bodyTop + sectionGeometry[1]!.hunkBounds.get(0)!.top;

    expect(
      findViewportCenteredHunkTarget({
        files,
        fileSectionLayouts,
        sectionGeometry,
        scrollTop: scrollTopForCenter(secondFileFirstHunkTop, viewportHeight),
        viewportHeight,
      }),
    ).toEqual({ fileId: "second", hunkIndex: 0 });
  });

  test("picks the nearest hunk when the viewport center lands in a collapsed gap", () => {
    const file = createWideTwoHunkFile("gap", "gap.ts");
    const geometry = measureDiffSectionGeometry(file, "split", true, theme, [], 160, true, false);
    const viewportHeight = 7;
    const fileSectionLayouts = buildFileSectionLayouts(
      [file],
      [geometry.bodyHeight],
      buildInStreamFileHeaderHeights([file]),
    );
    const firstHunk = geometry.hunkBounds.get(0)!;
    const secondHunk = geometry.hunkBounds.get(1)!;
    const centeredGapOffset = Math.max(firstHunk.top + firstHunk.height, secondHunk.top - 1);

    expect(
      findViewportCenteredHunkTarget({
        files: [file],
        fileSectionLayouts,
        sectionGeometry: [geometry],
        scrollTop: scrollTopForCenter(
          fileSectionLayouts[0]!.bodyTop + centeredGapOffset,
          viewportHeight,
        ),
        viewportHeight,
      }),
    ).toEqual({ fileId: "gap", hunkIndex: 1 });
  });
});
