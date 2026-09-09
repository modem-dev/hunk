import { describe, expect, test } from "bun:test";
import { buildLiveComment } from "../../core/liveComments";
import { reviewLineAnchor } from "../../core/review/anchors";
import type { ReviewHunkSpan } from "../../core/review/geometry";
import type { ReviewNoteV1 } from "../../core/review/types";
import {
  createTestDiffFile,
  createTestSourceFetcher,
} from "../../../../../test/helpers/diff-helpers";
import {
  groupStoredNotesByFileId,
  liveCommentToStoredNote,
  storedDraftToDraftNote,
  storedNoteToLiveComment,
  storedNoteToUserNote,
} from "./reviewNoteMapping";

/** Hunk spans placing new line 4 — the test live comment's line — in hunk 2. */
const testHunks: ReviewHunkSpan[] = [
  { additionStart: 1, additionCount: 1, deletionStart: 1, deletionCount: 1 },
  { additionStart: 2, additionCount: 1, deletionStart: 2, deletionCount: 1 },
  { additionStart: 4, additionCount: 1, deletionStart: 4, deletionCount: 1 },
];

/** Build one diff file with a real parsed hunk and an optional source fetcher. */
function testFile(id: string, fetcher?: ReturnType<typeof createTestSourceFetcher>) {
  return createTestDiffFile({
    after: "const alpha = 2;\n",
    before: "const alpha = 1;\n",
    id,
    path: `${id}.ts`,
    ...(fetcher ? { sourceFetcher: fetcher } : {}),
  });
}

/** Build one agent live comment the session daemon would produce. */
function testLiveComment() {
  return buildLiveComment(
    {
      filePath: "alpha.ts",
      side: "new",
      line: 4,
      summary: "summary",
      rationale: "rationale",
      markup: "<p>markup</p>",
      author: "agent",
    },
    "mcp:1",
    "2024-01-01T00:00:00.000Z",
    2,
  );
}

describe("live comment round trip", () => {
  test("restores every field the review stream renders", () => {
    const comment = testLiveComment();

    const restored = storedNoteToLiveComment(
      liveCommentToStoredNote(comment, "alpha", testHunks).note,
      comment.filePath,
    );

    expect(restored).toEqual({
      ...comment,
      reviewNoteId: comment.id,
      semanticallyStored: true,
      threadDepth: 0,
      title: undefined,
      updatedAt: undefined,
    });
  });

  test("classifies the note once, at the boundary", () => {
    const stored = liveCommentToStoredNote(testLiveComment(), "alpha", testHunks);

    expect(stored.note.source).toBe("agent");
    expect(stored.note.originalSource).toBe("mcp");
    expect(stored.note.editable).toBe(false);
    expect(stored.resolution).toBe("active");
  });
});

describe("user note projection", () => {
  test("renders a stored user note as an editable annotation", () => {
    const note: ReviewNoteV1 = {
      id: "user:1",
      source: "user",
      fileKey: "alpha",
      anchor: reviewLineAnchor(
        [
          { additionStart: 1, additionCount: 1, deletionStart: 1, deletionCount: 1 },
          { additionStart: 9, additionCount: 1, deletionStart: 9, deletionCount: 1 },
        ],
        { hunkIndex: 1, side: "old", line: 9 },
      ),
      summary: "needs a test",
      createdAt: "2024-01-01T00:00:00.000Z",
      editable: true,
    };

    expect(storedNoteToUserNote(note, "alpha.ts")).toEqual({
      id: "user:1",
      reviewNoteId: "user:1",
      semanticallyStored: true,
      threadDepth: 0,
      source: "user",
      filePath: "alpha.ts",
      hunkIndex: 1,
      side: "old",
      line: 9,
      author: "user",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: undefined,
      editable: true,
      oldRange: [9, 9],
      newRange: undefined,
      summary: "needs a test",
      rationale: undefined,
      markup: undefined,
      title: undefined,
      tags: undefined,
      confidence: undefined,
    });
  });
});

describe("draft projection", () => {
  test("derives the anchor range from the drafted line", () => {
    expect(
      storedDraftToDraftNote(
        { id: "draft:1", fileKey: "alpha", hunkIndex: 0, side: "new", line: 3, body: "wip" },
        testFile("alpha"),
      ),
    ).toEqual({
      id: "draft:1",
      kind: "create",
      fileId: "alpha",
      filePath: "alpha.ts",
      hunkIndex: 0,
      side: "new",
      line: 3,
      oldRange: undefined,
      newRange: [3, 3],
      body: "wip",
    });
  });
});

describe("groupStoredNotesByFileId", () => {
  const fileByKey = new Map([["alpha", testFile("alpha")]]);

  test("keeps stored order within one file", () => {
    const notes = ["mcp:1", "mcp:2"].map((id) =>
      liveCommentToStoredNote({ ...testLiveComment(), id }, "alpha", testHunks),
    );

    expect(
      groupStoredNotesByFileId(notes, fileByKey, storedNoteToLiveComment).alpha?.map(
        (note) => note.id,
      ),
    ).toEqual(["mcp:1", "mcp:2"]);
  });

  test("drops notes whose file left the review, and orphaned anchors", () => {
    const missingFile = liveCommentToStoredNote(testLiveComment(), "gone", testHunks);
    const orphaned = {
      ...liveCommentToStoredNote(testLiveComment(), "alpha", testHunks),
      resolution: "orphaned" as const,
    };

    expect(
      groupStoredNotesByFileId([missingFile, orphaned], fileByKey, storedNoteToLiveComment),
    ).toEqual({});
  });
});
