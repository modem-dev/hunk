import { describe, expect, test } from "bun:test";
import {
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import { reviewNoteListOrigin, selectReviewNoteList } from "./noteList";
import type { ReviewNoteV1 } from "./types";

/** One sidecar annotation on a new-side line. */
function createTestSidecarNote(id: string, fileKey: string, line: number): ReviewNoteV1 {
  return createTestStoredNote({ id, fileKey, line, hunkIndex: line > 10 ? 1 : 0 }).note;
}

describe("selectReviewNoteList", () => {
  test("groups threads by file in review order, sidecar first on a shared line", () => {
    const state = {
      ...createTestReviewState(["alpha", "beta"], { showAgentNotes: true }),
      liveNotes: [
        createTestStoredNote({ id: "live-beta", fileKey: "beta", line: 2 }),
        createTestStoredNote({ id: "live-alpha-late", fileKey: "alpha", hunkIndex: 1, line: 12 }),
        createTestStoredNote({ id: "live-alpha", fileKey: "alpha", line: 2 }),
        createTestStoredNote({ id: "reply", fileKey: "alpha", line: 2, parentId: "live-alpha" }),
      ],
    };
    const list = selectReviewNoteList(state, [
      { note: createTestSidecarNote("sidecar-alpha", "alpha", 2), resolution: "active" },
    ]);

    expect(list.map((file) => file.fileKey)).toEqual(["alpha", "beta"]);
    expect(
      list[0]!.threads.map((thread) => [
        thread.root.note.id,
        thread.replies.map((reply) => reply.note.id),
        thread.root.stored,
      ]),
    ).toEqual([
      ["sidecar-alpha", [], false],
      ["live-alpha", ["reply"], true],
      ["live-alpha-late", [], true],
    ]);
    expect(list[1]!.threads.map((thread) => thread.root.note.id)).toEqual(["live-beta"]);
  });

  test("applies the visibility policy and marks stale notes", () => {
    const state = {
      ...createTestReviewState(["alpha"]),
      liveNotes: [createTestStoredNote({ id: "agent", fileKey: "alpha", line: 2 })],
      userNotes: [
        createTestStoredNote({
          id: "mine",
          fileKey: "alpha",
          line: 3,
          source: "user",
          resolution: "stale",
        }),
      ],
    };
    const list = selectReviewNoteList(state, [
      { note: createTestSidecarNote("sidecar", "alpha", 2), resolution: "active" },
    ]);

    // Agent notes are hidden, so only the reviewer's own note is listed.
    expect(list[0]!.threads.map((thread) => [thread.root.note.id, thread.root.stale])).toEqual([
      ["mine", true],
    ]);
  });

  test("leaves out notes on files the shared filter hides", () => {
    const state = {
      ...createTestReviewState(["alpha", "beta"], { showAgentNotes: true }),
      filter: "beta",
      liveNotes: [createTestStoredNote({ id: "a", fileKey: "alpha", line: 2 })],
    };

    expect(selectReviewNoteList(state)).toEqual([]);
  });

  test("tells agent, reviewer, and browser-written notes apart", () => {
    const base = createTestStoredNote({ id: "n", fileKey: "alpha" }).note;
    expect(reviewNoteListOrigin({ ...base, source: "agent" })).toBe("agent");
    expect(reviewNoteListOrigin({ ...base, source: "ai" })).toBe("agent");
    expect(reviewNoteListOrigin({ ...base, source: "user", originalSource: "user" })).toBe(
      "reviewer",
    );
    expect(reviewNoteListOrigin({ ...base, source: "user", originalSource: "browser" })).toBe(
      "browser",
    );
  });
});
