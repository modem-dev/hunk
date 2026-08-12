import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { projectReviewDocument } from "./document";
import {
  resolveReviewLineAddress,
  resolveReviewNoteAnchor,
  reviewLineAddress,
  reviewLineContextDigest,
  reviewSourceLineContextDigest,
} from "./anchors";
import type { ReviewFileV1 } from "./types";

/** Project one terminal fixture into the canonical file model under test. */
function canonicalFile(file = createTestDiffFile()) {
  return projectReviewDocument(
    { id: "anchors", title: "anchors", sourceLabel: "test", files: [file] },
    { generation: "generation:anchors" },
  ).document.files[0]!;
}

describe("canonical review line addresses", () => {
  test("derives the backed hunk, array index, and context digest", () => {
    const file = canonicalFile(
      createTestDiffFile({
        before: lines("one", "two", "three"),
        after: lines("one", "changed", "three"),
      }),
    );
    const line = file.hunks[0]!.additionStart;
    const resolved = resolveReviewLineAddress(file, { side: "new", line, hunkIndex: 0 });
    const contextDigest = reviewLineContextDigest(file, "new", line);

    expect(contextDigest).toBeString();
    expect(resolved).toEqual({
      side: "new",
      line,
      hunkIndex: 0,
      arrayIndex: line - 1,
      contextDigest: contextDigest!,
    });
  });

  test("rejects unbacked lines, zero-count sides, and requested hunk mismatches", () => {
    const addition = canonicalFile(createTestDiffFile({ before: "", after: lines("added") }));
    const deletion = canonicalFile(createTestDiffFile({ before: lines("deleted"), after: "" }));
    const additionLine = addition.hunks[0]!.additionStart;
    const deletionLine = deletion.hunks[0]!.deletionStart;

    expect(resolveReviewLineAddress(addition, { side: "old", line: deletionLine })).toBeUndefined();
    expect(resolveReviewLineAddress(deletion, { side: "new", line: additionLine })).toBeUndefined();
    expect(
      resolveReviewLineAddress(addition, { side: "new", line: additionLine, hunkIndex: 1 }),
    ).toBeUndefined();
    expect(resolveReviewLineAddress(addition, { side: "new", line: 999 })).toBeUndefined();
    expect(resolveReviewLineAddress(addition, { side: "new", line: 1.5 })).toBeUndefined();
    expect(
      resolveReviewLineAddress(addition, { side: "new", line: 1, hunkIndex: -1 }),
    ).toBeUndefined();
  });

  test("normalizes CRLF and one trailing newline for full-source context digests", () => {
    expect(reviewSourceLineContextDigest("one\r\ntwo\r\nthree\r\n", 2)).toBe(
      reviewSourceLineContextDigest("one\ntwo\nthree", 2),
    );
    expect(reviewSourceLineContextDigest("one\n\nthree\n", 2)).toBeString();
    expect(reviewSourceLineContextDigest("one\n", 2)).toBeUndefined();
  });

  test("maps absolute lines through compact partial patch arrays", () => {
    const base = canonicalFile(createTestDiffFile({ before: lines("old"), after: lines("new") }));
    const sourceHunk = base.hunks[0]!;
    const partial: ReviewFileV1 = {
      ...base,
      flags: { ...base.flags, partial: true },
      additionLines: ["prefix", "line ten", "line eleven"],
      hunks: [
        {
          ...sourceHunk,
          additionStart: 10,
          additionCount: 2,
          additionLines: 2,
          additionLineIndex: 1,
        },
      ],
    };

    expect(reviewLineAddress(partial, "new", 10)).toEqual({ hunkIndex: 0, arrayIndex: 1 });
    expect(resolveReviewLineAddress(partial, { side: "new", line: 11 })).toMatchObject({
      hunkIndex: 0,
      arrayIndex: 2,
    });
    expect(resolveReviewLineAddress(partial, { side: "new", line: 9 })).toBeUndefined();
    expect(resolveReviewLineAddress(partial, { side: "new", line: 12 })).toBeUndefined();
  });
});

describe("canonical review note anchors", () => {
  test("preserves every intersection while the preferred new range owns placement", () => {
    const file = canonicalFile(
      createTestDiffFile({
        before: lines("old-one", "two", "three", "four", "old-five"),
        after: lines("new-one", "two", "three", "four", "new-five"),
        context: 0,
      }),
    );

    expect(
      resolveReviewNoteAnchor(file, {
        oldRange: [1, 1],
        newRange: [4, 5],
        preferred: { side: "new", line: 4 },
      }),
    ).toEqual({
      oldRange: [1, 1],
      newRange: [4, 5],
      preferred: { side: "new", line: 4 },
      intersectingHunkIndices: [0, 1],
      ownerHunkIndex: 1,
    });
  });

  test("uses explicit first-hunk fallbacks for range-less and unmatched notes", () => {
    const file = canonicalFile();

    expect(resolveReviewNoteAnchor(file, {})).toEqual({
      intersectingHunkIndices: [],
      ownerHunkIndex: 0,
    });
    expect(
      resolveReviewNoteAnchor(file, {
        newRange: [500, 500],
        preferred: { side: "new", line: 500 },
      }),
    ).toEqual({
      newRange: [500, 500],
      preferred: { side: "new", line: 500 },
      intersectingHunkIndices: [],
      ownerHunkIndex: 0,
    });
    expect(
      resolveReviewNoteAnchor(file, {
        newRange: [500, 500],
        preferred: { side: "new", line: 500 },
        fallbackOwnerHunkIndex: 1,
      }),
    ).toMatchObject({ intersectingHunkIndices: [], ownerHunkIndex: 1 });
  });

  test("keeps hunkless permissive anchors at file scope", () => {
    const file = { ...canonicalFile(), hunks: [] };

    expect(resolveReviewNoteAnchor(file, {})).toEqual({ intersectingHunkIndices: [] });
    expect(
      resolveReviewNoteAnchor(file, {
        oldRange: [1, 1],
        preferred: { side: "old", line: 1 },
      }),
    ).toEqual({
      oldRange: [1, 1],
      preferred: { side: "old", line: 1 },
      intersectingHunkIndices: [],
    });
  });

  test("permits stale zero-count boundary anchors without making them strict line targets", () => {
    const file = canonicalFile(createTestDiffFile({ before: "", after: lines("added") }));
    const boundary = file.hunks[0]!.deletionStart;

    expect(resolveReviewLineAddress(file, { side: "old", line: boundary })).toBeUndefined();
    expect(
      resolveReviewNoteAnchor(file, {
        oldRange: [boundary, boundary],
        preferred: { side: "old", line: boundary },
      }),
    ).toMatchObject({ intersectingHunkIndices: [0], ownerHunkIndex: 0 });
  });
});
