import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../core/types";
import { buildReviewSessionSnapshot, createReviewCommandState } from "./reviewCommandState";

/** Build a minimal diff file with real parsed hunk metadata. */
function createDiffFile(id: string, path: string, before: string, after: string): DiffFile {
  const metadata = parseDiffFromFile(
    { name: path, contents: before, cacheKey: `${id}:before` },
    { name: path, contents: after, cacheKey: `${id}:after` },
    { context: 3 },
    true,
  );

  return {
    id,
    path,
    patch: "",
    language: "typescript",
    stats: { additions: 1, deletions: 1 },
    metadata,
    agent: null,
  };
}

describe("review command state", () => {
  test("rehydrates editable user notes from session snapshots", () => {
    const file = createDiffFile(
      "alpha",
      "alpha.ts",
      "export const value = 1;\n",
      "export const value = 2;\n",
    );

    const state = createReviewCommandState({
      files: [file],
      initialSessionState: {
        selectedFileId: "alpha",
        selectedFilePath: "alpha.ts",
        selectedHunkIndex: 0,
        showAgentNotes: true,
        liveCommentCount: 0,
        liveComments: [],
        reviewNoteCount: 2,
        reviewNotes: [
          {
            noteId: "user:1",
            source: "user",
            filePath: "alpha.ts",
            hunkIndex: 0,
            newRange: [1, 1],
            body: "Keep this user note after remount.",
            author: "user",
            createdAt: "2026-05-23T00:00:00.000Z",
            editable: true,
          },
          {
            noteId: "agent:1",
            source: "agent",
            filePath: "alpha.ts",
            hunkIndex: 0,
            newRange: [1, 1],
            body: "Live agent note is rehydrated from liveComments instead.",
            author: "agent",
            createdAt: "2026-05-23T00:00:00.000Z",
            editable: false,
          },
        ],
      },
    });

    expect(state.userNotesByFileId.alpha).toMatchObject([
      {
        id: "user:1",
        source: "user",
        fileId: "alpha",
        filePath: "alpha.ts",
        hunkIndex: 0,
        side: "new",
        line: 1,
        summary: "Keep this user note after remount.",
        editable: true,
      },
    ]);

    const snapshot = buildReviewSessionSnapshot({
      files: [file],
      state,
      now: "2026-05-23T00:00:01.000Z",
    });

    expect(snapshot.state.reviewNoteCount).toBe(1);
    expect(snapshot.state.reviewNotes).toMatchObject([
      {
        noteId: "user:1",
        source: "user",
        filePath: "alpha.ts",
        hunkIndex: 0,
        newRange: [1, 1],
        body: "Keep this user note after remount.",
        editable: true,
      },
    ]);
  });
});
