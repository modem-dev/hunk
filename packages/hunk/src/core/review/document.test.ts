import { describe, expect, test } from "bun:test";
import {
  createTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../../../../test/helpers/diff-helpers";
import { projectReviewDocument, reviewEmptyDiffReason } from "./document";
import type { DiffFile } from "../changeset/model";

/** Build one small parsed file, optionally with expandable source. */
function testFile(
  id: string,
  overrides: Partial<Parameters<typeof createTestDiffFile>[0]> = {},
): DiffFile {
  return createTestDiffFile({
    before: lines("const alpha = 1;", "const keep = true;"),
    after: lines("const alpha = 2;", "const keep = true;"),
    id,
    path: `${id}.ts`,
    ...overrides,
  });
}

describe("projectReviewDocument", () => {
  test("keeps review order and carries each file's identity", () => {
    const document = projectReviewDocument([testFile("alpha"), testFile("beta")]);

    expect(document.files.map((file) => [file.path, file.runtimeId])).toEqual([
      ["alpha.ts", "alpha"],
      ["beta.ts", "beta"],
    ]);
    expect(new Set(document.files.map((file) => file.key)).size).toBe(2);
  });

  test("projects hunks, line arrays, and the parser's row totals", () => {
    const file = projectReviewDocument([testFile("alpha")]).files[0]!;

    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]?.index).toBe(0);
    expect(file.additionLines.length).toBeGreaterThan(0);
    // Carried from the parser rather than reduced from hunk spans (audit A7).
    expect(file.splitLineCount).toBeGreaterThan(0);
    expect(file.unifiedLineCount).toBeGreaterThan(0);
  });

  test("addresses a file the same way after a reload that changed it", () => {
    const before = projectReviewDocument([testFile("alpha")]).files[0]!;
    const after = projectReviewDocument([
      testFile("alpha", { after: lines("const alpha = 3;", "const keep = true;") }),
    ]).files[0]!;

    expect(after.key).toBe(before.key);
    expect(after.contentIdentity).not.toBe(before.contentIdentity);
  });

  test("gives two entries at one path distinct keys", () => {
    const document = projectReviewDocument([testFile("alpha"), testFile("alpha-again")]);
    const samePath = projectReviewDocument([
      testFile("alpha"),
      testFile("alpha-again", { path: "alpha.ts" }),
    ]);

    expect(document.files[0]?.key).not.toBe(document.files[1]?.key);
    expect(samePath.files[0]?.key).not.toBe(samePath.files[1]?.key);
  });

  test("separates the same file in two different reviews", () => {
    const head = projectReviewDocument([testFile("alpha")], { sourceLabel: "HEAD" });
    const previous = projectReviewDocument([testFile("alpha")], { sourceLabel: "HEAD~1" });

    expect(head.files[0]?.key).not.toBe(previous.files[0]?.key);
  });

  test("gives a file with no expandable source no source identity", () => {
    expect(projectReviewDocument([testFile("alpha")]).files[0]?.sourceIdentity).toBeUndefined();
  });

  test("keeps source identity while the content is unchanged and moves it when it is not", () => {
    const fetcher = createTestSourceFetcher(() => "const alpha = 1;\n");
    const identityOf = (file: DiffFile) => projectReviewDocument([file]).files[0]?.sourceIdentity;

    const first = identityOf(testFile("alpha", { sourceFetcher: fetcher }));

    expect(first).toBeDefined();
    // A reload that re-reads the same content hands over a new fetcher object; the state
    // derived from that content is still valid, so its identity must not move.
    expect(
      identityOf(
        testFile("alpha", { sourceFetcher: createTestSourceFetcher(() => "const alpha = 1;\n") }),
      ),
    ).toBe(first);
    expect(
      identityOf(
        testFile("alpha", {
          after: lines("const alpha = 3;", "const keep = true;"),
          sourceFetcher: fetcher,
        }),
      ),
    ).not.toBe(first);
  });

  test("copies the parser's line arrays so a later mutation cannot rewrite the document", () => {
    const file = testFile("alpha");
    const projected = projectReviewDocument([file]).files[0]!;
    file.metadata.additionLines[0] = "mutated";

    expect(projected.additionLines[0]).not.toBe("mutated");
  });
});

describe("reviewEmptyDiffReason", () => {
  const plain = { changeKind: "change", binary: false, tooLarge: false } as const;

  test("explains each way a file can render nothing", () => {
    expect(reviewEmptyDiffReason(plain)).toBe("no-hunks");
    expect(reviewEmptyDiffReason({ ...plain, binary: true })).toBe("binary");
    expect(reviewEmptyDiffReason({ ...plain, tooLarge: true })).toBe("too-large");
    expect(reviewEmptyDiffReason({ ...plain, changeKind: "new" })).toBe("new-file");
    expect(reviewEmptyDiffReason({ ...plain, changeKind: "deleted" })).toBe("deleted-file");
    expect(reviewEmptyDiffReason({ ...plain, changeKind: "rename-pure" })).toBe("rename-only");
  });

  test("lets what the change is outrank how it is stored", () => {
    expect(reviewEmptyDiffReason({ changeKind: "rename-pure", binary: true, tooLarge: true })).toBe(
      "rename-only",
    );
    expect(reviewEmptyDiffReason({ changeKind: "new", binary: true, tooLarge: true })).toBe(
      "binary",
    );
    expect(reviewEmptyDiffReason({ changeKind: "deleted", binary: false, tooLarge: true })).toBe(
      "too-large",
    );
  });
});
