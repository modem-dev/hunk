import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import {
  applyReviewIntent,
  ReviewIntentPlanningError,
  type ReviewIntentPlanningErrorCode,
} from "./intents";
import { MAX_REVIEW_NOTE_BYTES, MAX_REVIEW_NOTES, MAX_REVIEW_NOTES_TOTAL_BYTES } from "./noteSize";
import { selectIsReviewFileViewed } from "./selectors";
import type { ReviewState } from "./state";
import { createReviewStore } from "./store";

const FACTS = { noteId: "user:direct-1", timestamp: "2026-11-13T00:00:00.000Z" };

/** Create a store whose state starts from the given one. */
function createTestStore(state: ReviewState) {
  const store = createReviewStore(state.document);
  // Seed notes and drafts directly; planning only reads them.
  store.dispatch({ type: "notes/add-live", notes: state.liveNotes });
  return store;
}

/** Expect one planning rejection code. */
function expectRejected(run: () => unknown, code: ReviewIntentPlanningErrorCode) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewIntentPlanningError);
    expect((error as ReviewIntentPlanningError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("notes/add-user", () => {
  test("creates a note from body and target without touching the shared draft", () => {
    const store = createTestStore(createTestReviewState());
    applyReviewIntent(
      store,
      { type: "notes/start-draft", fileKey: "beta", hunkIndex: 0 },
      { draftId: "draft:terminal" },
    );
    const outcome = applyReviewIntent(
      store,
      {
        type: "notes/add-user",
        fileKey: "alpha",
        hunkIndex: 1,
        target: { side: "new", line: 12 },
        body: "  Direct note  ",
        author: "Ana",
      },
      FACTS,
    );

    expect(outcome.note.note).toMatchObject({
      id: "user:direct-1",
      fileKey: "alpha",
      summary: "Direct note",
      author: "Ana",
      source: "user",
      editable: true,
    });
    expect(outcome.note.note.anchor.ownerHunkIndex).toBe(1);
    expect(store.getSnapshot().draftNote?.id).toBe("draft:terminal");
    expect(store.getSnapshot().userNotes).toHaveLength(1);
  });

  test("replies inherit the parent's anchor and refuse a parent in another file", () => {
    const parent = createTestStoredNote({ id: "live:1", fileKey: "alpha", line: 2 });
    const store = createTestStore({ ...createTestReviewState(), liveNotes: [parent] });
    const reply = applyReviewIntent(
      store,
      { type: "notes/add-user", fileKey: "alpha", hunkIndex: 0, parentId: "live:1", body: "Re" },
      FACTS,
    );
    expect(reply.note.note.parentId).toBe("live:1");
    expect(reply.note.note.anchor).toEqual(parent.note.anchor);
    expect(reply.note.note.author).toBe("user");

    expectRejected(
      () =>
        applyReviewIntent(
          store,
          { type: "notes/add-user", fileKey: "beta", hunkIndex: 0, parentId: "live:1", body: "x" },
          { ...FACTS, noteId: "user:direct-2" },
        ),
      "invalid-note-parent",
    );
  });

  test("refuses blank, oversized, colliding, and fact-less notes", () => {
    const store = createTestStore(createTestReviewState());
    const intent = { type: "notes/add-user", fileKey: "alpha", hunkIndex: 0 } as const;
    expectRejected(() => applyReviewIntent(store, { ...intent, body: "  " }, FACTS), "blank-note");
    expectRejected(
      () => applyReviewIntent(store, { ...intent, body: "x".repeat(MAX_REVIEW_NOTE_BYTES) }, FACTS),
      "note-too-large",
    );
    expectRejected(() => applyReviewIntent(store, { ...intent, body: "x" }), "missing-fact");
    applyReviewIntent(store, { ...intent, body: "first" }, FACTS);
    expectRejected(
      () => applyReviewIntent(store, { ...intent, body: "again" }, FACTS),
      "note-id-conflict",
    );
  });
});

describe("notes/edit-user", () => {
  test("replaces the body in place and refuses blank edits and non-editable notes", () => {
    const store = createTestStore(createTestReviewState());
    applyReviewIntent(
      store,
      { type: "notes/add-user", fileKey: "alpha", hunkIndex: 0, body: "first" },
      FACTS,
    );
    const edited = applyReviewIntent(
      store,
      { type: "notes/edit-user", noteId: "user:direct-1", body: "second" },
      { timestamp: "2026-11-14T00:00:00.000Z" },
    );
    expect(edited.note.note).toMatchObject({
      summary: "second",
      updatedAt: "2026-11-14T00:00:00.000Z",
    });
    expect(store.getSnapshot().draftNote).toBeNull();
    expectRejected(
      () =>
        applyReviewIntent(
          store,
          { type: "notes/edit-user", noteId: "user:direct-1", body: " " },
          FACTS,
        ),
      "blank-note",
    );
    expectRejected(
      () =>
        applyReviewIntent(store, { type: "notes/edit-user", noteId: "live:9", body: "x" }, FACTS),
      "note-not-found",
    );
  });
});

describe("files/set-viewed", () => {
  test("marks a file at its content identity and drops the mark when the content changes", () => {
    const store = createTestStore(createTestReviewState(["alpha", "beta"]));
    applyReviewIntent(store, { type: "files/set-viewed", fileKey: "alpha", viewed: true });
    applyReviewIntent(store, { type: "files/set-viewed", fileKey: "beta", viewed: true });
    expect(selectIsReviewFileViewed(store.getSnapshot(), "alpha")).toBe(true);

    store.dispatch({
      type: "document/reconcile",
      document: createTestReviewDocument(["alpha", { key: "beta", contentIdentity: "content:v2" }]),
    });
    expect(selectIsReviewFileViewed(store.getSnapshot(), "alpha")).toBe(true);
    expect(selectIsReviewFileViewed(store.getSnapshot(), "beta")).toBe(false);
    expect(store.getSnapshot().viewedFiles).toEqual({
      alpha: { contentIdentity: "content:alpha" },
    });

    applyReviewIntent(store, { type: "files/set-viewed", fileKey: "alpha", viewed: false });
    expect(store.getSnapshot().viewedFiles).toEqual({});
    expectRejected(
      () => applyReviewIntent(store, { type: "files/set-viewed", fileKey: "gone", viewed: true }),
      "file-not-found",
    );
  });
});

// Finding: a review accepted notes without bound, so about seventeen maximum-size notes pushed
// the shared state past its size bound and about ten thousand small ones made the daemon refuse
// every snapshot. Every note-storing intent now checks the stored-note bounds.
describe("stored-note capacity", () => {
  /** Live notes of one size that fill the review up to `count`. */
  function createTestLiveNotes(count: number, summary = "n") {
    return Array.from({ length: count }, (_unused, index) =>
      createTestStoredNote({ id: `live:${index}`, fileKey: "alpha", line: 2, summary }),
    );
  }

  test("refuses one more note than the count bound, on every add path", () => {
    const store = createTestStore({
      ...createTestReviewState(),
      liveNotes: createTestLiveNotes(MAX_REVIEW_NOTES),
    });
    expectRejected(
      () =>
        applyReviewIntent(
          store,
          { type: "notes/add-user", fileKey: "alpha", hunkIndex: 0, body: "one more" },
          FACTS,
        ),
      "too-many-notes",
    );
    expectRejected(
      () =>
        applyReviewIntent(
          store,
          {
            type: "notes/add-user",
            fileKey: "alpha",
            hunkIndex: 0,
            parentId: "live:0",
            body: "re",
          },
          FACTS,
        ),
      "too-many-notes",
    );

    applyReviewIntent(
      store,
      { type: "notes/start-draft", fileKey: "alpha", hunkIndex: 0 },
      { draftId: "draft:1" },
    );
    store.dispatch({ type: "draft/update", body: "drafted" });
    expectRejected(
      () => applyReviewIntent(store, { type: "notes/create-user", consumeDraft: true }, FACTS),
      "too-many-notes",
    );
    expect(store.getSnapshot().liveNotes.length + store.getSnapshot().userNotes.length).toBe(
      MAX_REVIEW_NOTES,
    );
  });

  test("refuses notes whose total bytes would pass the byte bound, but allows shrinking edits", () => {
    // Notes just under the per-note bound, enough to sit just under the total.
    const big = "x".repeat(MAX_REVIEW_NOTE_BYTES - 400);
    const fitting = Math.floor(MAX_REVIEW_NOTES_TOTAL_BYTES / MAX_REVIEW_NOTE_BYTES);
    const store = createTestStore({
      ...createTestReviewState(),
      liveNotes: createTestLiveNotes(fitting, big),
    });
    applyReviewIntent(
      store,
      { type: "notes/add-user", fileKey: "alpha", hunkIndex: 0, body: "small" },
      FACTS,
    );
    expectRejected(
      () =>
        applyReviewIntent(
          store,
          { type: "notes/add-user", fileKey: "alpha", hunkIndex: 0, body: big },
          { ...FACTS, noteId: "user:direct-2" },
        ),
      "too-many-notes",
    );
    expectRejected(
      () =>
        applyReviewIntent(
          store,
          { type: "notes/edit-user", noteId: "user:direct-1", body: big },
          { timestamp: FACTS.timestamp },
        ),
      "too-many-notes",
    );
    // An edit that does not grow the note is allowed even in a full review.
    applyReviewIntent(
      store,
      { type: "notes/edit-user", noteId: "user:direct-1", body: "tiny" },
      { timestamp: FACTS.timestamp },
    );
    expect(store.getSnapshot().userNotes[0]!.note.summary).toBe("tiny");
  });
});
