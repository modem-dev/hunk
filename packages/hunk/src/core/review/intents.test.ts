import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
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

describe("selection movement intent", () => {
  const annotations = {
    annotatedHunkIndicesByFileKey: new Map([["beta", new Set([1])]]),
    annotatedFileKeys: new Set(["beta"]),
  };

  test("plans a move over the visible stream and reports where it landed", () => {
    const state = { ...createTestReviewState(), selection: { fileKey: "alpha", hunkIndex: 1 } };

    expect(planReviewIntent(state, { type: "selection/move", scope: "hunk", delta: 1 })).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "beta",
          hunkIndex: 0,
          reveal: { anchor: "file-top", scrollToNote: false },
        },
      ],
      outcome: { type: "selection/changed", fileKey: "beta", hunkIndex: 0 },
    });
  });

  test("publishes nothing when the scope refuses the move", () => {
    const state = { ...createTestReviewState(), selection: { fileKey: "beta", hunkIndex: 1 } };

    expect(planReviewIntent(state, { type: "selection/move", scope: "file", delta: 1 })).toEqual({
      actions: [],
    });
  });

  test("navigates only what the filter leaves visible", () => {
    const state = {
      ...createTestReviewState(),
      filter: "alpha",
      selection: { fileKey: "alpha", hunkIndex: 1 },
    };

    // Beta is filtered out, so the stream ends at alpha's last hunk.
    expect(planReviewIntent(state, { type: "selection/move", scope: "hunk", delta: 1 })).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "alpha",
          hunkIndex: 1,
          reveal: { anchor: "hunk", scrollToNote: false },
        },
      ],
      outcome: { type: "selection/changed", fileKey: "alpha", hunkIndex: 1 },
    });
  });

  test("requires the annotation index for annotated navigation", () => {
    const state = createTestReviewState();

    expect(() =>
      planReviewIntent(state, { type: "selection/move", scope: "annotated-hunk", delta: 1 }),
    ).toThrow(ReviewIntentPlanningError);
    expect(
      planReviewIntent(
        state,
        { type: "selection/move", scope: "annotated-hunk", delta: 1 },
        { annotations },
      ).actions,
    ).toEqual([
      {
        type: "selection/select",
        fileKey: "beta",
        hunkIndex: 1,
        reveal: { anchor: "hunk", scrollToNote: true },
      },
    ]);
  });
});

describe("file jump intent", () => {
  test("lands on the file's first hunk and reveals its header by default", () => {
    expect(
      planReviewIntent(createTestReviewState(), {
        type: "selection/select-file",
        fileKey: "beta",
      }),
    ).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "beta",
          hunkIndex: 0,
          reveal: { anchor: "file-top", scrollToNote: false },
        },
      ],
      outcome: { type: "selection/changed", fileKey: "beta", hunkIndex: 0 },
    });
  });

  test("accepts a caller's own reveal request", () => {
    expect(
      planReviewIntent(createTestReviewState(), {
        type: "selection/select-file",
        fileKey: "beta",
        reveal: { anchor: "hunk", scrollToNote: false },
      }).actions[0],
    ).toEqual({
      type: "selection/select",
      fileKey: "beta",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
    });
  });

  test("rejects a file the review does not contain", () => {
    expect(() =>
      planReviewIntent(createTestReviewState(), {
        type: "selection/select-file",
        fileKey: "missing",
      }),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("viewport anchor intent", () => {
  // Intent: a viewport reporting where it settled must not scroll anybody, including itself.
  test("moves the selection without bumping a reveal counter", () => {
    const state = createTestReviewState();
    const plan = planReviewIntent(state, {
      type: "selection/anchor",
      fileKey: "beta",
      hunkIndex: 1,
    });

    expect(plan).toEqual({
      actions: [
        {
          type: "selection/select",
          fileKey: "beta",
          hunkIndex: 1,
          reveal: { anchor: "none", scrollToNote: false },
        },
      ],
    });

    const next = plan.actions.reduce(reduceReviewState, state);
    expect(next.selection).toEqual({ fileKey: "beta", hunkIndex: 1 });
    expect(next.reveal).toEqual({ fileTopToken: 0, hunkToken: 0, scrollToNote: false });
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

describe("user note editing", () => {
  test("prefills an edit draft and replaces the saved note without changing its identity", () => {
    const original = createTestStoredNote({
      id: "user-1",
      fileKey: "alpha",
      source: "user",
      summary: "before",
      editable: true,
      createdAt: "2023-01-01T00:00:00.000Z",
    });
    const state = { ...createTestReviewState(), userNotes: [original] };
    const started = planReviewIntent(
      state,
      { type: "notes/start-edit", noteId: "user-1" },
      { draftId: "draft:edit" },
    );
    const withDraft = started.actions.reduce(reduceReviewState, state);

    expect(withDraft.draftNote).toMatchObject({
      kind: "edit",
      targetNoteId: "user-1",
      body: "before",
    });
    const edited = planReviewIntent(withDraft, {
      type: "notes/update-draft",
      body: "  after  ",
    }).actions.reduce(reduceReviewState, withDraft);
    const saved = planReviewIntent(
      edited,
      { type: "notes/update-user", noteId: "user-1", consumeDraft: true },
      { timestamp: FACTS.timestamp },
    );
    const next = saved.actions.reduce(reduceReviewState, edited);

    expect(saved.outcome).toMatchObject({ type: "notes/updated" });
    expect(next.draftNote).toBeNull();
    expect(next.userNotes).toHaveLength(1);
    expect(next.userNotes[0]?.note).toMatchObject({
      id: "user-1",
      summary: "after",
      createdAt: "2023-01-01T00:00:00.000Z",
      updatedAt: FACTS.timestamp,
    });
    expect(next.userNotes[0]?.note.anchor).toEqual(original.note.anchor);
  });

  test("reopens retained notes after reload clamps away their former hunk", () => {
    const original = createTestStoredNote({
      id: "user-1",
      fileKey: "alpha",
      hunkIndex: 1,
      source: "user",
      editable: true,
    });
    const state = {
      ...createTestReviewState([{ key: "alpha", hunkCount: 1 }]),
      userNotes: [original],
    };

    const plan = planReviewIntent(
      state,
      { type: "notes/start-edit", noteId: "user-1" },
      { draftId: "draft:edit" },
    );

    expect(plan.outcome).toMatchObject({
      type: "notes/draft-started",
      draft: { kind: "edit", targetNoteId: "user-1", hunkIndex: 0 },
    });
  });

  test("rejects blank edits without retiring the draft", () => {
    const state = {
      ...createTestReviewState(),
      userNotes: [
        createTestStoredNote({
          id: "user-1",
          fileKey: "alpha",
          source: "user",
          editable: true,
        }),
      ],
    };
    const started = planReviewIntent(
      state,
      { type: "notes/start-edit", noteId: "user-1" },
      { draftId: "draft:edit" },
    ).actions.reduce(reduceReviewState, state);
    const blank = reduceReviewState(started, { type: "draft/update", body: "  " });

    expect(() =>
      planReviewIntent(
        blank,
        { type: "notes/update-user", noteId: "user-1", consumeDraft: true },
        { timestamp: FACTS.timestamp },
      ),
    ).toThrow(ReviewIntentPlanningError);
    expect(blank.draftNote).not.toBeNull();
  });
});

describe("threaded replies", () => {
  test("copies the parent's anchor and records its direct identity", () => {
    const parent = createTestStoredNote({ id: "live-1", fileKey: "alpha", hunkIndex: 1, line: 12 });
    const state = { ...createTestReviewState(), liveNotes: [parent] };
    const started = planReviewIntent(
      state,
      { type: "notes/start-reply", noteId: "live-1" },
      { draftId: "draft:reply" },
    ).actions.reduce(reduceReviewState, state);
    const written = planReviewIntent(started, {
      type: "notes/update-draft",
      body: "reply body",
    }).actions.reduce(reduceReviewState, started);
    const plan = planReviewIntent(
      written,
      { type: "notes/create-user", consumeDraft: true },
      FACTS,
    );

    expect(plan.outcome).toMatchObject({
      type: "notes/created",
      note: { note: { id: "user:1", parentId: "live-1", summary: "reply body" } },
    });
    expect(
      plan.outcome?.type === "notes/created" ? plan.outcome.note.note.anchor : undefined,
    ).toEqual(parent.note.anchor);
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

  test("blocks removing a parent while replies still reference it", () => {
    const state = {
      ...createTestReviewState(),
      liveNotes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })],
      userNotes: [
        createTestStoredNote({
          id: "reply-1",
          parentId: "live-1",
          fileKey: "alpha",
          source: "user",
        }),
      ],
    };

    expect(() => planReviewIntent(state, { type: "notes/remove-live", noteId: "live-1" })).toThrow(
      new ReviewIntentPlanningError(
        "note-has-replies",
        "Review note live-1 cannot be removed while it has replies.",
      ),
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

  test("rejects clearing a live parent while retaining its user reply", () => {
    const state = {
      ...createTestReviewState(),
      liveNotes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })],
      userNotes: [
        createTestStoredNote({
          id: "reply-1",
          parentId: "live-1",
          fileKey: "alpha",
          source: "user",
        }),
      ],
    };

    expect(() => planReviewIntent(state, { type: "notes/clear" })).toThrow(
      new ReviewIntentPlanningError(
        "note-has-replies",
        "Review notes cannot be cleared while replies to them would remain.",
      ),
    );
    expect(
      planReviewIntent(state, { type: "notes/clear", includeUser: true }).outcome,
    ).toMatchObject({ removedLiveCount: 1, removedUserCount: 1 });
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

describe("notes/start-draft", () => {
  test("opens a draft at the hunk's default note target and reveals it", () => {
    const state = createTestReviewState();

    const plan = planReviewIntent(
      state,
      { type: "notes/start-draft", fileKey: "alpha", hunkIndex: 1 },
      { draftId: "draft:1" },
    );

    expect(plan.actions).toEqual([
      {
        type: "draft/start",
        draft: {
          kind: "create",
          id: "draft:1",
          fileKey: "alpha",
          hunkIndex: 1,
          // The second test hunk starts at line 11 with one context line before the change.
          side: "new",
          line: 12,
          body: "",
        },
      },
      {
        type: "selection/select",
        fileKey: "alpha",
        hunkIndex: 1,
        reveal: { anchor: "hunk", scrollToNote: true },
      },
    ]);
    expect(plan.outcome).toEqual({
      type: "notes/draft-started",
      draft: {
        kind: "create",
        id: "draft:1",
        fileKey: "alpha",
        hunkIndex: 1,
        side: "new",
        line: 12,
        body: "",
      },
    });
  });

  test("honors a caller-measured line target and reveal request", () => {
    const plan = planReviewIntent(
      createTestReviewState(),
      {
        type: "notes/start-draft",
        fileKey: "alpha",
        hunkIndex: 0,
        target: { side: "old", line: 2 },
        reveal: { anchor: "none", scrollToNote: false },
      },
      { draftId: "draft:2" },
    );

    expect(plan.actions[0]).toMatchObject({
      type: "draft/start",
      draft: { side: "old", line: 2 },
    });
    expect(plan.actions[1]).toMatchObject({ reveal: { anchor: "none", scrollToNote: false } });
  });

  test("requires the caller to own the draft's identity", () => {
    expect(() =>
      planReviewIntent(createTestReviewState(), {
        type: "notes/start-draft",
        fileKey: "alpha",
        hunkIndex: 0,
      }),
    ).toThrow(ReviewIntentPlanningError);
  });

  test("rejects a hunk the file does not have", () => {
    expect(() =>
      planReviewIntent(
        createTestReviewState(),
        { type: "notes/start-draft", fileKey: "alpha", hunkIndex: 9 },
        { draftId: "draft:3" },
      ),
    ).toThrow(ReviewIntentPlanningError);
  });
});

describe("expansion/toggle", () => {
  test("expands a collapsed gap and reports the address it resolved", () => {
    const plan = planReviewIntent(createTestReviewState(), {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
    });

    expect(plan.actions).toEqual([
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: true },
    ]);
    expect(plan.outcome).toEqual({
      type: "expansion/toggled",
      fileKey: "alpha",
      gapId: "before:1",
      expanded: true,
      side: "new",
      oldRange: [2, 10],
      newRange: [2, 10],
      lineCount: 9,
    });
  });

  test("collapses a gap that is already expanded", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
      expanded: true,
    });

    const plan = planReviewIntent(state, {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
    });

    expect(plan.actions).toEqual([
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: false },
    ]);
    expect(plan.outcome).toMatchObject({ expanded: false });
  });

  test("carries the source identity a caller needs to fill the gap", () => {
    const state = createTestReviewState([{ key: "alpha", sourceIdentity: "source:alpha" }]);

    const plan = planReviewIntent(state, {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
    });

    expect(plan.outcome).toMatchObject({ sourceIdentity: "source:alpha" });
  });

  test("rejects a gap id the file's geometry does not address", () => {
    for (const gapId of ["before:0", "trailing:1", "nonsense"]) {
      expect(() =>
        planReviewIntent(createTestReviewState(), {
          type: "expansion/toggle",
          fileKey: "alpha",
          gapId,
        }),
      ).toThrow(ReviewIntentPlanningError);
    }
  });
});
