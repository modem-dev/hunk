import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestReviewState,
  createTestStoredNote,
} from "../../../test/helpers/review-store-helpers";
import {
  applyReviewIntent,
  isBlankReviewNoteBody,
  planReviewIntent,
  ReviewIntentPlanningError,
} from "./intents";
import { reduceReviewState } from "./reducer";
import type { ReviewState } from "./state";
import { createReviewStore } from "./store";

const FACTS = { noteId: "user:1", timestamp: "2024-01-01T00:00:00.000Z" };

/** Start a draft at the given body so note creation has something to consume. */
function stateWithDraft(body: string): ReviewState {
  return reduceReviewState(createTestReviewState(), {
    type: "draft/start",
    draft: {
      id: "draft-1",
      fileKey: "alpha",
      hunkIndex: 1,
      side: "new",
      line: 12,
      body,
    },
  });
}

describe("isBlankReviewNoteBody", () => {
  test("treats whitespace-only bodies as blank", () => {
    expect(isBlankReviewNoteBody("")).toBe(true);
    expect(isBlankReviewNoteBody("  \n\t ")).toBe(true);
    expect(isBlankReviewNoteBody(" text ")).toBe(false);
  });
});

describe("selection intent", () => {
  test("lowers to one selection action carrying the reveal request", () => {
    expect(
      planReviewIntent(createTestReviewState(), {
        type: "selection/select",
        fileKey: "beta",
        hunkIndex: 1,
        reveal: { anchor: "file-top", scrollToNote: true },
      }).actions,
    ).toEqual([
      {
        type: "selection/select",
        fileKey: "beta",
        hunkIndex: 1,
        reveal: { anchor: "file-top", scrollToNote: true },
      },
    ]);
  });

  test("rejects a file the review does not contain", () => {
    expect(() =>
      planReviewIntent(createTestReviewState(), {
        type: "selection/select",
        fileKey: "missing",
        hunkIndex: 0,
        reveal: { anchor: "hunk", scrollToNote: false },
      }),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("user note creation", () => {
  test("anchors the note to the draft's line and hunk", () => {
    const plan = planReviewIntent(
      stateWithDraft("  looks wrong  "),
      {
        type: "notes/create-user",
        consumeDraft: true,
      },
      FACTS,
    );

    expect(plan.outcome).toEqual({
      type: "notes/created",
      note: {
        note: {
          id: "user:1",
          source: "user",
          originalSource: "user",
          fileKey: "alpha",
          anchor: {
            newRange: [12, 12],
            preferred: { side: "new", line: 12 },
            intersectingHunkIndices: [1],
            ownerHunkIndex: 1,
          },
          summary: "looks wrong",
          author: "user",
          createdAt: FACTS.timestamp,
          editable: true,
        },
        resolution: "active",
      },
    });
    expect(plan.actions.map((action) => action.type)).toEqual(["draft/save"]);
  });

  test("retires a blank draft instead of persisting an empty note", () => {
    const plan = planReviewIntent(
      stateWithDraft("   "),
      { type: "notes/create-user", consumeDraft: true },
      FACTS,
    );

    expect(plan.actions).toEqual([{ type: "draft/cancel" }]);
    expect(plan.outcome).toBeUndefined();
  });

  test("rejects creation without a draft or without caller-owned facts", () => {
    expect(() =>
      planReviewIntent(
        createTestReviewState(),
        { type: "notes/create-user", consumeDraft: true },
        FACTS,
      ),
    ).toThrow(new ReviewIntentPlanningError("draft-missing", "No user note draft is active."));
    expect(() =>
      planReviewIntent(stateWithDraft("body"), { type: "notes/create-user", consumeDraft: true }),
    ).toThrow(ReviewIntentPlanningError);
  });

  test("rejects a draft anchored to a hunk the file no longer has", () => {
    const reloaded = reduceReviewState(stateWithDraft("body"), {
      type: "document/reconcile",
      document: createTestReviewDocument([{ key: "alpha", hunkCount: 1 }, { key: "beta" }]),
    });

    expect(() =>
      planReviewIntent(reloaded, { type: "notes/create-user", consumeDraft: true }, FACTS),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("note removal", () => {
  test("removes from the collection that owns the note", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "notes/add-live",
      notes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })],
    });

    expect(planReviewIntent(state, { type: "notes/remove-live", noteId: "live-1" })).toEqual({
      actions: [{ type: "notes/remove-live", noteId: "live-1" }],
      outcome: { type: "notes/removed", noteId: "live-1", source: "live" },
    });
    expect(() => planReviewIntent(state, { type: "notes/remove-user", noteId: "live-1" })).toThrow(
      ReviewIntentPlanningError,
    );
  });
});

describe("bulk clear", () => {
  test("reports removed and remaining counts for one file", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "notes/add-live",
      notes: [
        createTestStoredNote({ id: "live-1", fileKey: "alpha" }),
        createTestStoredNote({ id: "live-2", fileKey: "beta" }),
      ],
    });

    expect(planReviewIntent(state, { type: "notes/clear", fileKey: "alpha" }).outcome).toEqual({
      type: "notes/cleared",
      removedLiveCount: 1,
      removedUserCount: 0,
      remainingLiveCount: 1,
      remainingUserCount: 0,
    });
  });

  test("counts user notes only when the caller clears them too", () => {
    const withDraft = reduceReviewState(createTestReviewState(), {
      type: "draft/start",
      draft: { id: "d", fileKey: "alpha", hunkIndex: 0, side: "new", line: 1, body: "x" },
    });
    const state = reduceReviewState(withDraft, {
      type: "draft/save",
      note: createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" }),
    });

    expect(planReviewIntent(state, { type: "notes/clear" }).outcome).toMatchObject({
      removedUserCount: 0,
      remainingUserCount: 1,
    });
    expect(
      planReviewIntent(state, { type: "notes/clear", includeUser: true }).outcome,
    ).toMatchObject({
      removedUserCount: 1,
      remainingUserCount: 0,
    });
  });
});

describe("applyReviewIntent", () => {
  test("commits the planned actions and returns the outcome", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha", "beta"]));
    store.dispatch({
      type: "draft/start",
      draft: { id: "d", fileKey: "alpha", hunkIndex: 0, side: "new", line: 3, body: "note body" },
    });

    const outcome = applyReviewIntent(
      store,
      { type: "notes/create-user", consumeDraft: true },
      FACTS,
    );

    expect(outcome?.type).toBe("notes/created");
    expect(store.getSnapshot().draftNote).toBeNull();
    expect(store.getSnapshot().userNotes.map((entry) => entry.note.id)).toEqual(["user:1"]);
  });

  test("leaves state untouched when planning rejects the intent", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha"]));
    const before = store.getSnapshot();

    expect(() =>
      applyReviewIntent(store, { type: "notes/remove-user", noteId: "missing" }),
    ).toThrow(ReviewIntentPlanningError);
    expect(store.getSnapshot()).toBe(before);
  });
});
