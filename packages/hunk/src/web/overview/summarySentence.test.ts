import { describe, expect, test } from "bun:test";
import { selectReviewOverview, type ReviewOverviewFileInput } from "../../core/review/overview";
import { selectSummarySentence } from "./summarySentence";

/** One overview input file with the given stats. */
function testFile(
  path: string,
  additions: number,
  deletions: number,
  truncated = false,
): ReviewOverviewFileInput {
  return {
    key: path,
    path,
    changeKind: "change",
    stats: { additions, deletions, truncated },
    flags: { binary: false, tooLarge: false, untracked: false },
  } as ReviewOverviewFileInput;
}

describe("selectSummarySentence", () => {
  test("names a file that holds at least 80% of the changed lines, with exact leftovers", () => {
    const sentence = selectSummarySentence(
      selectReviewOverview({
        files: [
          testFile("data/huge.json", 24_999, 0),
          testFile("a.ts", 30, 10),
          testFile("b.ts", 19, 36),
        ],
      }),
    );

    expect(sentence).toEqual({
      kind: "file",
      path: "data/huge.json",
      additions: 24_999,
      deletions: 0,
      truncated: false,
      rest: { files: 2, additions: 49, deletions: 46 },
    });
  });

  test("needs more than one file and a strict share", () => {
    expect(
      selectSummarySentence(selectReviewOverview({ files: [testFile("only.ts", 100, 0)] })),
    ).toBeUndefined();

    // 79 of 100 changed lines is below the threshold; 80 of 100 is at it.
    const below = selectSummarySentence(
      selectReviewOverview({ files: [testFile("a/x.ts", 79, 0), testFile("b/y.ts", 21, 0)] }),
    );
    expect(below).toBeUndefined();
    const at = selectSummarySentence(
      selectReviewOverview({ files: [testFile("a/x.ts", 80, 0), testFile("b/y.ts", 20, 0)] }),
    );
    expect(at?.kind).toBe("file");
  });

  test("drops the leftovers when a count is a lower bound", () => {
    const sentence = selectSummarySentence(
      selectReviewOverview({
        files: [testFile("big.sql", 9_000, 0, true), testFile("a.ts", 10, 0)],
      }),
    );

    expect(sentence).toMatchObject({ kind: "file", path: "big.sql", truncated: true });
    expect(sentence && "rest" in sentence).toBe(false);
  });

  test("names a top-level directory that holds 60% of the files", () => {
    const sentence = selectSummarySentence(
      selectReviewOverview({
        files: [
          testFile("src/a.ts", 5, 1),
          testFile("src/b.ts", 4, 2),
          testFile("src/c.ts", 5, 1),
          testFile("docs/d.md", 4, 2),
          testFile("test/e.ts", 3, 3),
        ],
      }),
    );

    expect(sentence).toEqual({ kind: "directory", directory: "src", files: 3, total: 5 });
  });

  test("uses the first segment of a compacted directory chain", () => {
    const sentence = selectSummarySentence(
      selectReviewOverview({
        files: [
          testFile("packages/hunk/src/a.ts", 5, 1),
          testFile("packages/hunk/src/b.ts", 4, 2),
          testFile("packages/hunk/src/c.ts", 5, 1),
          testFile("docs/d.md", 4, 2),
        ],
      }),
    );

    expect(sentence).toMatchObject({ kind: "directory", directory: "packages", files: 3 });
  });

  test("says nothing for an even spread, a single directory, or an empty review", () => {
    expect(
      selectSummarySentence(
        selectReviewOverview({
          files: [testFile("a/x.ts", 5, 5), testFile("b/y.ts", 5, 5), testFile("c/z.ts", 5, 5)],
        }),
      ),
    ).toBeUndefined();
    expect(
      selectSummarySentence(
        selectReviewOverview({ files: [testFile("a/x.ts", 5, 5), testFile("a/y.ts", 5, 5)] }),
      ),
    ).toBeUndefined();
    expect(selectSummarySentence(selectReviewOverview({ files: [] }))).toBeUndefined();
  });
});
