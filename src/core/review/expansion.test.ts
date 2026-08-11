import { describe, expect, test } from "bun:test";
import { projectReviewDocument } from "./document";
import { reviewGapAddress } from "./expansion";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";

describe("reviewGapAddress", () => {
  test("maps leading context across zero-count insertion and deletion sides", () => {
    const projectFile = (before: string, after: string) =>
      projectReviewDocument(
        {
          id: "zero-side-gap",
          title: "zero side gap",
          sourceLabel: "fixture",
          files: [
            createTestDiffFile({
              id: "zero-side-file",
              path: "zero-side.ts",
              before,
              after,
              context: 0,
            }),
          ],
        },
        { generation: "generation:zero-side" },
      ).document.files[0]!;

    const insertion = projectFile("one\ntwo\nthree\n", "one\ninserted\ntwo\nthree\n");
    expect(insertion.hunks[0]).toMatchObject({
      collapsedBefore: 1,
      deletionCount: 0,
      additionCount: 1,
    });
    expect(reviewGapAddress(insertion, "before:0")).toEqual({
      oldRange: [1, 1],
      newRange: [1, 1],
    });

    const deletion = projectFile("one\ntwo\nremoved\nthree\n", "one\ntwo\nthree\n");
    expect(deletion.hunks[0]).toMatchObject({
      collapsedBefore: 1,
      deletionCount: 1,
      additionCount: 0,
    });
    expect(reviewGapAddress(deletion, "before:0")).toEqual({
      oldRange: [2, 2],
      newRange: [2, 2],
    });
  });

  test("accepts only bounded semantic before and final trailing gap ids", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const after = [...lines];
    after[15] = "changed";
    const file = projectReviewDocument(
      {
        id: "gap-test",
        title: "gap test",
        sourceLabel: "fixture",
        files: [
          createTestDiffFile({
            id: "gap-file",
            path: "gap.ts",
            before: `${lines.join("\n")}\n`,
            after: `${after.join("\n")}\n`,
          }),
        ],
      },
      { generation: "generation:gaps" },
    ).document.files[0]!;

    expect(reviewGapAddress(file, "before:0")).toBeDefined();
    expect(reviewGapAddress(file, `trailing:${file.hunks.length - 1}`)).toBeDefined();
    for (const malformed of [
      "before:-1",
      "before:0:extra",
      "before:1e2",
      "before:01junk",
      "trailing:999999999999999999999999",
      "other:0",
      "",
    ]) {
      expect(reviewGapAddress(file, malformed)).toBeUndefined();
    }
  });

  test("rejects fabricated, partial, non-final, and asymmetric trailing gaps", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const after = [...lines];
    after[8] = "first change";
    after[28] = "second change";
    const file = projectReviewDocument(
      {
        id: "invalid-gap-test",
        title: "invalid gaps",
        sourceLabel: "fixture",
        files: [
          createTestDiffFile({
            id: "invalid-gap-file",
            path: "invalid-gap.ts",
            before: `${lines.join("\n")}\n`,
            after: `${after.join("\n")}\n`,
            context: 2,
          }),
        ],
      },
      { generation: "generation:invalid-gaps" },
    ).document.files[0]!;

    expect(file.hunks.length).toBe(2);
    expect(reviewGapAddress(file, "trailing:0")).toBeUndefined();
    expect(
      reviewGapAddress({ ...file, flags: { ...file.flags, partial: true } }, "trailing:1"),
    ).toBeUndefined();
    expect(
      reviewGapAddress({ ...file, additionLines: file.additionLines.slice(0, -1) }, "trailing:1"),
    ).toBeUndefined();
    expect(
      reviewGapAddress(
        {
          ...file,
          hunks: [{ ...file.hunks[0]!, collapsedBefore: 0 }, ...file.hunks.slice(1)],
        },
        "before:0",
      ),
    ).toBeUndefined();
    expect(reviewGapAddress(file, `before:${file.hunks.length}`)).toBeUndefined();
  });
});
