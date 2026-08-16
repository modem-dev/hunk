import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import {
  FILE_HEADER_OVERFLOW_MARKER,
  fileHeaderStats,
  fitFileHeaderLabel,
  maxFileHeaderStatsWidth,
} from "./fileHeader";
import { measureTextWidth } from "./text";

describe("file header layout", () => {
  test("reserves only the widest rendered stats text", () => {
    const small = createTestDiffFile({ id: "small", path: "small.ts" });
    const large = createTestDiffFile({ id: "large", path: "large.ts" });
    small.stats = { additions: 1, deletions: 0 };
    large.stats = { additions: 1234, deletions: 56 };
    large.statsTruncated = true;

    expect(fileHeaderStats(small)).toMatchObject({ text: "+1 ", width: 3 });
    expect(fileHeaderStats(large)).toMatchObject({ text: "+1234+ -56 ", width: 11 });
    expect(maxFileHeaderStatsWidth([small, large])).toBe(11);
  });

  test("states the churn the shared formatter states, so a zero count is not a badge", () => {
    const added = createTestDiffFile({ id: "added", path: "added.ts" });
    const removed = createTestDiffFile({ id: "removed", path: "removed.ts" });
    const unchanged = createTestDiffFile({ id: "unchanged", path: "unchanged.ts" });
    added.stats = { additions: 3, deletions: 0 };
    removed.stats = { additions: 0, deletions: 7 };
    unchanged.stats = { additions: 0, deletions: 0 };

    expect(fileHeaderStats(added)).toMatchObject({
      additionsText: "+3",
      deletionsText: null,
      text: "+3 ",
    });
    expect(fileHeaderStats(removed)).toMatchObject({
      additionsText: null,
      deletionsText: "-7",
      text: "-7 ",
    });
    expect(fileHeaderStats(unchanged)).toMatchObject({
      additionsText: null,
      deletionsText: null,
      text: "",
      width: 0,
    });
  });

  test("fits long paths with three dots while preserving terminal-cell width", () => {
    const file = createTestDiffFile({
      id: "long-path",
      path: "packages/visual-studio-code-vscode/extension-postgres.ts",
    });

    const label = fitFileHeaderLabel(file, 29);

    expect(label.filename).toBe(`packages/visual-studio-cod${FILE_HEADER_OVERFLOW_MARKER}`);
    expect(measureTextWidth(label.filename)).toBe(29);
  });

  test("keeps state labels outside the path truncation budget", () => {
    const file = createTestDiffFile({ id: "new-file", path: "longer-filename.ts" });
    file.metadata.type = "new";

    expect(fitFileHeaderLabel(file, 14)).toEqual({ filename: "longe...", stateLabel: " (new)" });
  });

  test("drops a state label before it can displace the path or stats", () => {
    const file = createTestDiffFile({ id: "tiny-new-file", path: "longer-filename.ts" });
    file.metadata.type = "new";

    expect(fitFileHeaderLabel(file, 5)).toEqual({ filename: "lo...", stateLabel: null });
    expect(fitFileHeaderLabel(file, 0)).toEqual({ filename: "", stateLabel: null });
  });
});
