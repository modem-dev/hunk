import { describe, expect, test } from "bun:test";
import {
  projectMinimap,
  streamToTrack,
  trackToStreamScroll,
  type MinimapFileInput,
} from "./minimapProjection";

/** One file of `body` pixels whose single hunk covers its second quarter. */
function createTestMinimapFile(
  key: string,
  body: number,
  overrides: Partial<MinimapFileInput> = {},
): MinimapFileInput {
  return {
    key,
    headerHeight: 0,
    bodyHeight: body,
    stats: { additions: 4, deletions: 2 },
    rows: {
      splitLineCount: 4,
      unifiedLineCount: 4,
      hunks: [{ splitLineStart: 1, splitLineCount: 1, unifiedLineStart: 1, unifiedLineCount: 1 }],
      hunkChanges: [{ additions: 4, deletions: 2 }],
    },
    ...overrides,
  };
}

/** The bins of one array that carry weight. */
function weighted(bins: Float32Array) {
  return Array.from(bins.entries())
    .filter(([, weight]) => weight > 0)
    .map(([bin]) => bin);
}

describe("projectMinimap", () => {
  test("scales the stream's heights onto the track and places hunks by row fraction", () => {
    const model = projectMinimap({
      files: [createTestMinimapFile("a", 400), createTestMinimapFile("b", 400)],
      layout: "unified",
      trackHeight: 80,
      binHeight: 1,
    });

    expect(model.streamHeight).toBe(800);
    expect(model.boundaries).toEqual([0, 40]);
    // Each file's hunk is its second quarter: track rows 10–20 and 50–60.
    expect(weighted(model.added)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
    ]);
    expect(Array.from(model.added).reduce((sum, value) => sum + value, 0)).toBeCloseTo(8);
    expect(Array.from(model.removed).reduce((sum, value) => sum + value, 0)).toBeCloseTo(4);
  });

  test("spreads an unloaded file's stats over its body", () => {
    const model = projectMinimap({
      files: [createTestMinimapFile("a", 100, { rows: undefined, headerHeight: 0 })],
      layout: "split",
      trackHeight: 10,
    });

    expect(weighted(model.added)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("marks notes, highlights, viewed files, and the selected hunk", () => {
    const model = projectMinimap({
      files: [
        createTestMinimapFile("a", 400, { noteHunks: [0], viewed: true }),
        createTestMinimapFile("b", 400, { highlightHunks: [0] }),
      ],
      layout: "unified",
      trackHeight: 80,
      selected: { fileKey: "b", hunkIndex: 0 },
    });

    expect(model.notes).toEqual([10]);
    expect(model.highlights).toEqual([50]);
    expect(model.viewed).toEqual([{ top: 0, height: 40 }]);
    expect(model.selected).toEqual({ top: 50, height: 10 });
  });

  test("coarsens: a 2,000-file review keeps one bin per pixel and drops sub-pixel boundaries", () => {
    const files = Array.from({ length: 2_000 }, (_unused, index) =>
      createTestMinimapFile(`f${index}`, 60, { headerHeight: 34 }),
    );
    const started = performance.now();
    const model = projectMinimap({ files, layout: "unified", trackHeight: 800 });

    expect(model.added.length).toBe(800);
    expect(model.boundaries).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("track and stream offsets", () => {
  const model = { streamHeight: 1_000, trackHeight: 100 };

  test("map scroll offsets to the track proportionally", () => {
    expect(streamToTrack(model, 500)).toBe(50);
    expect(streamToTrack({ streamHeight: 0, trackHeight: 100 }, 10)).toBe(0);
  });

  test("center the viewport on a track point, clamped to the scroll range", () => {
    expect(trackToStreamScroll(model, 50, 200)).toBe(400);
    expect(trackToStreamScroll(model, 0, 200)).toBe(0);
    expect(trackToStreamScroll(model, 100, 200)).toBe(800);
  });
});
