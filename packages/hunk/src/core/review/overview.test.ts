import { describe, expect, test } from "bun:test";
import {
  reviewOverviewNoteOrigin,
  reviewSizeClass,
  selectReviewOverview,
  type ReviewOverviewFileInput,
} from "./overview";

/** One file's overview facts with the given stats. */
function createTestOverviewFile(
  path: string,
  additions: number,
  deletions: number,
  overrides: Partial<ReviewOverviewFileInput> = {},
): ReviewOverviewFileInput {
  return {
    key: `file:${path}`,
    path,
    changeKind: "change",
    stats: { additions, deletions, truncated: false },
    flags: { untracked: false, binary: false, tooLarge: false, partial: false },
    ...overrides,
  };
}

const FILES = [
  createTestOverviewFile("src/app.ts", 40, 10),
  createTestOverviewFile("src/lib/util.ts", 5, 5, { changeKind: "new" }),
  createTestOverviewFile("src/app.test.ts", 30, 0),
  createTestOverviewFile("README.md", 3, 1),
  createTestOverviewFile("bun.lock", 200, 180),
  createTestOverviewFile("assets/logo.png", 0, 0, {
    changeKind: "rename-pure",
    previousPath: "logo.png",
    flags: { untracked: false, binary: true, tooLarge: false, partial: false },
  }),
  createTestOverviewFile("package.json", 2, 2, {
    stats: { additions: 2, deletions: 2, truncated: true },
  }),
];

describe("selectReviewOverview", () => {
  test("totals every file and marks a lower bound when any file is truncated", () => {
    const overview = selectReviewOverview({ files: FILES });

    expect(overview.totals).toEqual({ files: 7, additions: 280, deletions: 198, truncated: true });
  });

  test("keeps meaningful totals to source and config, beside the full totals", () => {
    const overview = selectReviewOverview({ files: FILES });

    // app.ts, util.ts, logo.png (source) and package.json (config).
    expect(overview.meaningful).toEqual({
      files: 4,
      additions: 47,
      deletions: 17,
      truncated: true,
    });
    expect(overview.roles.test).toEqual({
      files: 1,
      additions: 30,
      deletions: 0,
      truncated: false,
    });
    expect(overview.roles.docs.files).toBe(1);
    expect(overview.roles.generated).toEqual({
      files: 1,
      additions: 200,
      deletions: 180,
      truncated: false,
    });
  });

  test("partitions change kinds and counts overlapping flags separately", () => {
    expect(selectReviewOverview({ files: FILES }).changeKinds).toEqual({
      new: 1,
      modified: 5,
      deleted: 0,
      renamed: 1,
      renamedChanged: 0,
      untracked: 0,
      binary: 1,
      tooLarge: 0,
    });
  });

  test("classifies size by meaningful lines at the stated thresholds", () => {
    expect([0, 9, 10, 29, 30, 99, 100, 499, 500, 5000].map(reviewSizeClass)).toEqual([
      "XS",
      "XS",
      "S",
      "S",
      "M",
      "M",
      "L",
      "L",
      "XL",
      "XL",
    ]);
    // 47 + 17 meaningful lines; the lockfile's 380 do not make the review large.
    expect(selectReviewOverview({ files: FILES }).sizeClass).toBe("M");
  });

  test("rolls directories up largest first, compacting single-child chains", () => {
    const overview = selectReviewOverview({
      files: [
        createTestOverviewFile("packages/hunk/src/a.ts", 1, 0),
        createTestOverviewFile("packages/hunk/src/core/b.ts", 10, 0),
        createTestOverviewFile("docs/c.md", 50, 0),
        createTestOverviewFile("top.ts", 2, 0),
      ],
    });
    const root = overview.directories;

    expect(root.files).toBe(4);
    expect(root.children.map((child) => [child.name, child.files, child.additions])).toEqual([
      ["docs", 1, 50],
      ["packages/hunk/src", 2, 11],
    ]);
    const src = root.children[1]!;
    expect(src.path).toBe("packages/hunk/src");
    expect(src.firstFileKey).toBe("file:packages/hunk/src/a.ts");
    expect(src.children.map((child) => [child.name, child.path])).toEqual([
      ["core", "packages/hunk/src/core"],
    ]);
  });

  test("lists the largest files by churn, ties in document order, skipping empty ones", () => {
    const overview = selectReviewOverview({ files: FILES, largestFileLimit: 3 });

    expect(overview.largestFiles.map((file) => file.path)).toEqual([
      "bun.lock",
      "src/app.ts",
      "src/app.test.ts",
    ]);
    expect(
      selectReviewOverview({ files: FILES }).largestFiles.some((file) =>
        file.path.endsWith(".png"),
      ),
    ).toBe(false);
  });

  test("counts notes per file by origin in document order, and viewed progress once marked", () => {
    const overview = selectReviewOverview({
      files: FILES,
      notes: [
        { fileKey: "file:README.md", origin: "reviewer" },
        { fileKey: "file:src/app.ts", origin: "agent" },
        { fileKey: "file:src/app.ts", origin: "agent" },
        { fileKey: "file:src/app.ts", origin: "reviewer" },
        { fileKey: "file:gone.ts", origin: "agent" },
      ],
      viewedFiles: { "file:src/app.ts": {}, "file:gone.ts": {} },
    });

    expect(overview.notesByFile).toEqual([
      { fileKey: "file:src/app.ts", path: "src/app.ts", agent: 2, reviewer: 1 },
      { fileKey: "file:README.md", path: "README.md", agent: 0, reviewer: 1 },
    ]);
    expect(overview.noteTotals).toEqual({ agent: 2, reviewer: 2 });
    expect(overview.viewed).toEqual({ files: 1, total: 7 });
    expect(selectReviewOverview({ files: FILES }).viewed).toBeUndefined();
    expect(reviewOverviewNoteOrigin("user")).toBe("reviewer");
    expect(reviewOverviewNoteOrigin("ai")).toBe("agent");
  });

  test("summarizes an empty review", () => {
    const overview = selectReviewOverview({ files: [] });

    expect(overview.totals).toEqual({ files: 0, additions: 0, deletions: 0, truncated: false });
    expect(overview.sizeClass).toBe("XS");
    expect(overview.directories.children).toEqual([]);
  });
});
