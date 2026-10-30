import { describe, expect, test } from "bun:test";
import { createTestReviewDocument } from "../../../../../test/helpers/review-store-helpers";
import {
  createInitialReviewState,
  isRenderableStoredReviewNote,
  reviewNoteVisibleByPolicy,
} from "./state";
import type { ReviewStoredNote } from "./state";

/** Build one minimal review document with the given file keys. */
function testDocument(...keys: string[]) {
  return createTestReviewDocument(keys);
}

/** Build one stored note carrying only what the visibility policy reads. */
function testStoredNote(resolution: ReviewStoredNote["resolution"]): ReviewStoredNote {
  return {
    note: {
      id: "note-1",
      source: "user",
      fileKey: "alpha",
      anchor: { intersectingHunkIndices: [0] },
      summary: "body",
      editable: true,
    },
    resolution,
  };
}

describe("createInitialReviewState", () => {
  test("selects the first file of the document", () => {
    const state = createInitialReviewState(testDocument("alpha", "beta"));

    expect(state.selection).toEqual({ fileKey: "alpha", hunkIndex: 0 });
    expect(state.reveal).toEqual({ fileTopToken: 0, hunkToken: 0, scrollToNote: false });
    expect(state.stateRevision).toBe(0);
  });

  test("leaves selection unaddressed for an empty review", () => {
    expect(createInitialReviewState(testDocument()).selection.fileKey).toBeNull();
  });

  test("adopts the caller's note visibility default", () => {
    expect(createInitialReviewState(testDocument("alpha")).showAgentNotes).toBe(false);
    expect(
      createInitialReviewState(testDocument("alpha"), { showAgentNotes: true }).showAgentNotes,
    ).toBe(true);
  });
});

describe("reviewNoteVisibleByPolicy", () => {
  test("keeps the reviewer's own notes when the agent layer is hidden", () => {
    expect(reviewNoteVisibleByPolicy({ source: "user" }, false)).toBe(true);
    expect(reviewNoteVisibleByPolicy({ source: "agent" }, false)).toBe(false);
    expect(reviewNoteVisibleByPolicy({ source: "ai" }, false)).toBe(false);
  });

  test("shows every note when the layer is on", () => {
    expect(reviewNoteVisibleByPolicy({ source: "agent" }, true)).toBe(true);
    expect(reviewNoteVisibleByPolicy({ source: "ai" }, true)).toBe(true);
  });
});

describe("isRenderableStoredReviewNote", () => {
  test("keeps stale notes visible at their last known anchor", () => {
    expect(isRenderableStoredReviewNote(testStoredNote("active"))).toBe(true);
    expect(isRenderableStoredReviewNote(testStoredNote("stale"))).toBe(true);
  });

  test("hides notes whose anchor no longer exists", () => {
    expect(isRenderableStoredReviewNote(testStoredNote("orphaned"))).toBe(false);
  });
});
