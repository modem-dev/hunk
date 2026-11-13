import { describe, expect, test } from "bun:test";
import { loadAppBootstrap } from "../changeset/loaders";
import { projectReviewDocument } from "./document";
import {
  reviewExpandedGapContents,
  reviewFileWithExpandedGaps,
  reviewGapSourceForFile,
  reviewLeadingGap,
} from "./expansion";
import type { ReviewFileV1 } from "./types";

const AFTER = Array.from({ length: 30 }, (_unused, index) =>
  index === 9 || index === 24 ? `line ${index + 1} changed` : `line ${index + 1}`,
);

const PATCH = [
  "diff --git a/partial.ts b/partial.ts",
  "--- a/partial.ts",
  "+++ b/partial.ts",
  "@@ -9,3 +9,3 @@",
  " line 9",
  "-line 10",
  "+line 10 changed",
  " line 11",
  "@@ -24,3 +24,3 @@",
  " line 24",
  "-line 25",
  "+line 25 changed",
  " line 26",
  "",
].join("\n");

/** A two-hunk partial file, loaded from a patch, with gaps before and between its hunks. */
async function createTestPartialFile() {
  const bootstrap = await loadAppBootstrap({ kind: "patch", text: PATCH, options: {} });
  const [file] = projectReviewDocument(bootstrap.changeset.files, { sourceLabel: "/test" }).files;
  return file!;
}

/** The text one hunk shows on its new side, line by line, without terminators. */
function newSideOf(file: ReviewFileV1, hunkIndex: number) {
  const hunk = file.hunks[hunkIndex]!;
  return file.additionLines
    .slice(hunk.additionLineIndex, hunk.additionLineIndex + hunk.additionCount)
    .map((line) => line.replace(/\n$/u, ""));
}

describe("reviewFileWithExpandedGaps", () => {
  test("leaves a file with nothing expanded untouched", async () => {
    const file = await createTestPartialFile();
    expect(reviewFileWithExpandedGaps(file, [])).toBe(file);
  });

  // Intent: a partial patch holds only patch lines, so an expansion must insert the gap's
  // lines and move every later hunk past them, or the later hunk shows the wrong text.
  test("inserts a partial file's gap lines and re-bases the hunks after it", async () => {
    const file = await createTestPartialFile();
    expect(file.flags.partial).toBe(true);
    const contents = reviewExpandedGapContents(file, ["before:1"], `${AFTER.join("\n")}\n`);
    expect(contents).toHaveLength(1);

    const expanded = reviewFileWithExpandedGaps(file, contents);
    const gap = reviewLeadingGap(reviewGapSourceForFile(file), 1)!;

    // The second hunk now starts at its gap and reads straight through it.
    expect(expanded.hunks[1]!.additionStart).toBe(gap.newRange[0]);
    expect(expanded.hunks[1]!.collapsedBefore).toBe(0);
    expect(newSideOf(expanded, 1)).toEqual([
      ...AFTER.slice(gap.newRange[0] - 1, gap.newRange[1]),
      ...newSideOf(file, 1),
    ]);
    // The first hunk is unchanged, and row totals do not move.
    expect(newSideOf(expanded, 0)).toEqual(newSideOf(file, 0));
    expect(expanded.splitLineCount).toBe(file.splitLineCount);
    expect(expanded.contentIdentity).toBe(file.contentIdentity);
  });

  test("skips a gap the source does not fully cover", async () => {
    const file = await createTestPartialFile();
    expect(reviewExpandedGapContents(file, ["before:1"], "too short\n")).toEqual([]);
    expect(reviewExpandedGapContents(file, ["before:9", "nonsense"], AFTER.join("\n"))).toEqual([]);
  });
});
