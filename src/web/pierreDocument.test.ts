import { describe, expect, test } from "bun:test";
import { projectReviewDocument } from "../core/review/document";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import {
  buildReviewFileRenderModel,
  isolateReviewHunk,
  reviewExpandedGapRows,
} from "./pierreDocument";

const BASE = Array.from({ length: 24 }, (_unused, index) => `line ${index + 1}`).join("\n") + "\n";
/** Two changes far enough apart to parse as two hunks, with context between them. */
const CHANGED = BASE.replace("line 4", "line 4 changed").replace("line 20", "line 20 changed");

/** One real parse, so the model is built from geometry a parser produced. */
function modelFor(before: string, after: string) {
  const document = projectReviewDocument(
    [createTestDiffFile({ id: "alpha", path: "src/alpha.ts", before, after, context: 3 })],
    { sourceLabel: "/repo" },
  );
  return { file: document.files[0]!, model: buildReviewFileRenderModel(document.files[0]!) };
}

describe("buildReviewFileRenderModel", () => {
  test("carries the row totals the parser measured rather than reducing over hunks", () => {
    const { file, model } = modelFor(BASE, CHANGED);
    const reduced = file.hunks.reduce((total, hunk) => total + hunk.splitLineCount, 0);

    // A7: the file's totals include rows outside every hunk span, which is exactly why a
    // renderer that reduces over hunks mis-sizes its virtualization.
    expect(model.splitLineCount).toBe(file.splitLineCount);
    expect(model.unifiedLineCount).toBe(file.unifiedLineCount);
    expect(model.splitLineCount).not.toBe(reduced);
  });

  test("reads the expansion side from the file's change kind", () => {
    expect(modelFor(BASE, CHANGED).model.expansionSide).toBe("new");
    expect(modelFor(BASE, "").model.expansionSide).toBe("old");
  });

  test("offers one hunk per hunk, addressed by the review's own index", () => {
    const { file, model } = modelFor(BASE, CHANGED);

    expect(model.hunks.map((hunk) => hunk.index)).toEqual(file.hunks.map((_hunk, index) => index));
    expect(model.hunks.length).toBeGreaterThan(1);
  });

  test("reports why a file with no rows has none", () => {
    const document = projectReviewDocument(
      [
        {
          ...createTestDiffFile({ id: "bin", path: "logo.png", before: BASE, after: BASE }),
          isBinary: true,
        },
      ],
      { sourceLabel: "/repo" },
    );

    expect(buildReviewFileRenderModel(document.files[0]!).emptyDiffReason).toBe("binary");
  });
});

describe("isolateReviewHunk", () => {
  test("slices exactly the lines the shared re-basing walk consumed", () => {
    const { file } = modelFor(BASE, CHANGED);

    for (const hunk of file.hunks) {
      const isolated = isolateReviewHunk(file, hunk);
      const only = isolated.hunks[0]!;

      // A6: origins are zero and the sliced arrays are exactly as long as the hunk's own
      // content, so a renderer never reads a neighbouring hunk's lines.
      expect(only.additionLineIndex).toBe(0);
      expect(only.deletionLineIndex).toBe(0);
      expect(only.collapsedBefore).toBe(0);
      expect(isolated.additionLines).toEqual(
        file.additionLines.slice(
          hunk.additionLineIndex,
          hunk.additionLineIndex + isolated.additionLines.length,
        ),
      );
      expect(isolated.additionLines.length).toBe(hunk.additionCount);
      expect(isolated.deletionLines.length).toBe(hunk.deletionCount);
    }
  });

  test("keeps the file's identity in the highlight cache key", () => {
    const { file } = modelFor(BASE, CHANGED);

    expect(isolateReviewHunk(file, file.hunks[0]!).cacheKey).toBe(`${file.contentIdentity}:0`);
  });

  test("stays partial: a review file carries the patch's lines, not the file's", () => {
    const { file } = modelFor(BASE, CHANGED);

    expect(isolateReviewHunk(file, file.hunks[0]!).isPartial).toBe(true);
  });
});

describe("reviewExpandedGapRows", () => {
  test("labels each revealed line with the gap's own addresses", () => {
    const { file, model } = modelFor(BASE, CHANGED);
    const gap = model.gaps[0]!;

    const rows = reviewExpandedGapRows(file, gap.gapId, CHANGED)!;

    expect(rows).toHaveLength(gap.lineCount);
    expect(rows[0]).toEqual({
      oldLine: gap.oldRange[0],
      newLine: gap.newRange[0],
      text: `line ${gap.newRange[0]}`,
    });
  });

  test("normalizes CRLF rather than leaking carriage returns into a row", () => {
    const { file, model } = modelFor(
      BASE.replaceAll("\n", "\r\n"),
      CHANGED.replaceAll("\n", "\r\n"),
    );

    const rows = reviewExpandedGapRows(
      file,
      model.gaps[0]!.gapId,
      CHANGED.replaceAll("\n", "\r\n"),
    )!;

    expect(rows.every((row) => !row.text.includes("\r"))).toBe(true);
  });

  test("reveals nothing for a gap this file does not have", () => {
    const { file } = modelFor(BASE, CHANGED);

    expect(reviewExpandedGapRows(file, "before:99", CHANGED)).toBeUndefined();
  });
});
