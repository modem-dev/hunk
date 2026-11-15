import { describe, expect, test } from "bun:test";
import { createTestReviewHunk } from "../../../../../test/helpers/review-store-helpers";
import { buildReviewThreadCursors, reviewSidecarThreadId } from "./annotations";

/** Two hunks per file: lines 1-3 and 11-13 on both sides. */
const HUNKS = [createTestReviewHunk(0), createTestReviewHunk(1)];

describe("reviewSidecarThreadId", () => {
  test("keeps explicit ids and positional ids in disjoint namespaces", () => {
    expect(reviewSidecarThreadId("alpha", { id: "3", summary: "named" }, 0)).toBe(
      "sidecar:alpha:id:3",
    );
    expect(reviewSidecarThreadId("alpha", { summary: "unnamed" }, 3)).toBe("sidecar:alpha:at:3");
  });
});

describe("buildReviewThreadCursors", () => {
  test("orders stored roots and sidecar annotations by file, hunk, then line", () => {
    const threads = buildReviewThreadCursors({
      files: [
        {
          fileKey: "alpha",
          hunks: HUNKS,
          sidecar: [
            { summary: "late", newRange: [12, 12] },
            { id: "early", summary: "early", newRange: [2, 2] },
          ],
        },
        { fileKey: "beta", hunks: HUNKS },
      ],
      storedRoots: [
        { fileKey: "beta", hunkIndex: 0, line: { side: "new", line: 1 }, noteId: "beta-root" },
        { fileKey: "alpha", hunkIndex: 0, line: { side: "new", line: 2 }, noteId: "alpha-root" },
      ],
      showAgentNotes: true,
    });

    // A stored root sorts ahead of a sidecar annotation on the same line.
    expect(threads.map((thread) => [thread.threadId, thread.kind, thread.hunkIndex])).toEqual([
      ["alpha-root", "stored", 0],
      ["sidecar:alpha:id:early", "sidecar", 0],
      ["sidecar:alpha:at:0", "sidecar", 1],
      ["beta-root", "stored", 0],
    ]);
  });

  test("leaves out hidden hunks, hidden files, and agent sidecars the note layer hides", () => {
    const threads = buildReviewThreadCursors({
      files: [
        {
          fileKey: "alpha",
          hunks: HUNKS,
          hunkIndexes: [1],
          sidecar: [
            { summary: "hidden hunk", source: "user", newRange: [2, 2] },
            { summary: "agent", newRange: [12, 12] },
            { summary: "reviewer", source: "user", newRange: [13, 13] },
          ],
        },
      ],
      storedRoots: [
        { fileKey: "gamma", hunkIndex: 0, line: { side: "new", line: 1 }, noteId: "elsewhere" },
      ],
      showAgentNotes: false,
    });

    expect(threads.map((thread) => thread.threadId)).toEqual(["sidecar:alpha:at:2"]);
  });

  test("anchors a removed-line sidecar to its old-side line", () => {
    const [thread] = buildReviewThreadCursors({
      files: [
        { fileKey: "alpha", hunks: HUNKS, sidecar: [{ summary: "gone", oldRange: [12, 12] }] },
      ],
      storedRoots: [],
      showAgentNotes: true,
    });

    expect(thread).toMatchObject({ hunkIndex: 1, line: { side: "old", line: 12 } });
  });
});
