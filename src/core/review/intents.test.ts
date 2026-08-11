import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { projectReviewDocument } from "./document";
import {
  isLiveReviewNoteRemovable,
  planReviewIntent,
  ReviewIntentPlanningError,
  type ReviewIntentPlanningErrorCode,
} from "./intents";
import { createInitialReviewState, type ReviewState, type ReviewStoredNote } from "./state";
import { prepareReviewState } from "./store";
import type { ReviewFileV1, ReviewNoteV1 } from "./types";

/** Project one terminal file into a canonical intent-planning state. */
function createStateForSource(source: ReturnType<typeof createTestDiffFile>) {
  const document = projectReviewDocument(
    { id: "intents", title: "Intent test", sourceLabel: "test", files: [source] },
    { generation: "generation:intents" },
  ).document;
  return createInitialReviewState(document);
}

/** Build one canonical state with two separated changed hunks by default. */
function createState() {
  return createStateForSource(
    createTestDiffFile({
      before: lines("old one", "stable two", "stable three", "stable four", "old five"),
      after: lines("new one", "stable two", "stable three", "stable four", "new five"),
      context: 0,
    }),
  );
}

/** Return one backed target in the requested canonical hunk. */
function targetIn(file: ReviewFileV1, hunkIndex = 0, side: "old" | "new" = "new") {
  const hunk = file.hunks[hunkIndex]!;
  return {
    fileKey: file.key,
    hunkIndex,
    side,
    line: side === "new" ? hunk.additionStart : hunk.deletionStart,
  } as const;
}

/** Assert one typed planning failure without accepting generic exceptions. */
function expectPlanningError(run: () => unknown, code: ReviewIntentPlanningErrorCode) {
  try {
    run();
    throw new Error(`Expected planning error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewIntentPlanningError);
    expect((error as ReviewIntentPlanningError).code).toBe(code);
  }
}

/** Require the concrete outcome returned by one successful note-creation plan. */
function requireCreatedOutcome(plan: ReturnType<typeof planReviewIntent>) {
  if (plan.outcome?.type !== "note/created") throw new Error("Expected created-note outcome.");
  return plan.outcome.note;
}

/** Extract the canonical stored note from one successful create plan. */
function createdNote(state: ReviewState, id = "user:1") {
  const file = state.document.files[0]!;
  const plan = planReviewIntent(
    state,
    {
      type: "note/create-user",
      ...targetIn(file),
      body: "created",
    },
    { noteId: id, timestamp: "2026-01-01T00:00:00.000Z" },
  );
  return requireCreatedOutcome(plan);
}

/** Build one mutable note entry with controlled origin and editability. */
function mutableNote(
  state: ReviewState,
  id: string,
  options: {
    origin?: ReviewNoteV1["origin"];
    editable?: boolean;
    resolution?: ReviewStoredNote["resolution"];
  } = {},
) {
  const base = createdNote(state, id);
  return {
    ...base,
    resolution: options.resolution ?? base.resolution,
    note: {
      ...base.note,
      id,
      origin: options.origin ?? base.note.origin,
      editable: options.editable ?? base.note.editable,
    },
  };
}

describe("semantic user note intents", () => {
  test("creates canonical notes from backed lines and explicit runtime facts", () => {
    const state = createState();
    const file = state.document.files[0]!;
    const target = targetIn(file, 1, "new");
    const plan = planReviewIntent(
      state,
      {
        type: "note/create-user",
        ...target,
        body: "  explain this change  ",
        markup: "<strong>explain</strong>",
      },
      { noteId: "user:fixed", timestamp: "2026-02-03T04:05:06.000Z" },
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      type: "notes/add-user",
      expectedGeneration: state.documentGeneration,
    });
    expect(plan.outcome).toMatchObject({
      type: "note/created",
      note: {
        note: {
          id: "user:fixed",
          source: "user",
          origin: "user",
          originalSource: "user",
          fileKey: file.key,
          summary: "explain this change",
          markup: "<strong>explain</strong>",
          author: "user",
          createdAt: "2026-02-03T04:05:06.000Z",
          editable: true,
          anchor: {
            newRange: [target.line, target.line],
            preferred: { side: "new", line: target.line },
            intersectingHunkIndices: [1],
            ownerHunkIndex: 1,
          },
        },
        resolution: "active",
      },
    });
    const outcome = plan.outcome as Extract<typeof plan.outcome, { type: "note/created" }>;
    expect(outcome.note.contextDigest).toBeString();
    expect(outcome.note.contextDigests).toEqual({ new: outcome.note.contextDigest! });
  });

  test("creates side-specific notes for addition-only and deletion-only hunks", () => {
    const cases = [
      {
        state: createStateForSource(createTestDiffFile({ before: "", after: lines("added") })),
        validSide: "new" as const,
        invalidSide: "old" as const,
      },
      {
        state: createStateForSource(createTestDiffFile({ before: lines("deleted"), after: "" })),
        validSide: "old" as const,
        invalidSide: "new" as const,
      },
    ];

    for (const { state, validSide, invalidSide } of cases) {
      const file = state.document.files[0]!;
      const hunk = file.hunks[0]!;
      const validLine = validSide === "new" ? hunk.additionStart : hunk.deletionStart;
      const plan = planReviewIntent(
        state,
        {
          type: "note/create-user",
          fileKey: file.key,
          hunkIndex: 0,
          side: validSide,
          line: validLine,
          body: `${validSide} note`,
        },
        { noteId: `user:${validSide}`, timestamp: "2026-01-01T00:00:00.000Z" },
      );
      const stored = requireCreatedOutcome(plan);
      expect(stored.note.anchor).toMatchObject({
        [`${validSide === "new" ? "new" : "old"}Range`]: [validLine, validLine],
        preferred: { side: validSide, line: validLine },
        ownerHunkIndex: 0,
      });
      expect(stored.contextDigest).toBeString();
      expect(stored.contextDigests).toEqual({ [validSide]: stored.contextDigest! });

      const invalidLine = invalidSide === "new" ? hunk.additionStart : hunk.deletionStart;
      expectPlanningError(
        () =>
          planReviewIntent(
            state,
            {
              type: "note/create-user",
              fileKey: file.key,
              hunkIndex: 0,
              side: invalidSide,
              line: invalidLine,
              body: "wrong zero-count side",
            },
            { noteId: "user:invalid", timestamp: "2026-01-01T00:00:00.000Z" },
          ),
        "line-not-backed",
      );
    }
  });

  test("resolves compact partial-patch lines before constructing note evidence", () => {
    const state = createStateForSource(
      createTestDiffFile({ before: lines("old"), after: lines("new") }),
    );
    const base = state.document.files[0]!;
    const partial: ReviewFileV1 = {
      ...base,
      flags: { ...base.flags, partial: true },
      additionLines: ["unrelated compact row", "line ten", "line eleven"],
      hunks: [
        {
          ...base.hunks[0]!,
          additionStart: 10,
          additionCount: 2,
          additionLines: 2,
          additionLineIndex: 1,
        },
      ],
    };
    state.document = { ...state.document, files: [partial] };
    state.selection = { fileKey: partial.key, hunkIndex: 0 };

    const plan = planReviewIntent(
      state,
      {
        type: "note/create-user",
        fileKey: partial.key,
        hunkIndex: 0,
        side: "new",
        line: 11,
        body: "compact line",
      },
      { noteId: "user:partial", timestamp: "2026-01-01T00:00:00.000Z" },
    );
    const stored = requireCreatedOutcome(plan);
    expect(stored.note.anchor).toMatchObject({
      newRange: [11, 11],
      preferred: { side: "new", line: 11 },
      ownerHunkIndex: 0,
    });
    expect(stored.contextDigests).toEqual({ new: stored.contextDigest! });

    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          {
            type: "note/create-user",
            fileKey: partial.key,
            hunkIndex: 0,
            side: "new",
            line: 12,
            body: "outside compact patch",
          },
          { noteId: "user:invalid", timestamp: "2026-01-01T00:00:00.000Z" },
        ),
      "line-not-backed",
    );
  });

  test("creates and selects backed context lines on either canonical side", () => {
    const state = createStateForSource(
      createTestDiffFile({
        before: lines("shared context", "old value"),
        after: lines("shared context", "new value"),
        context: 1,
      }),
    );
    const file = state.document.files[0]!;
    const hunk = file.hunks[0]!;
    const contextLine = hunk.additionStart;
    expect(file.additionLines[contextLine - 1]?.trim()).toBe("shared context");
    expect(file.deletionLines[contextLine - 1]?.trim()).toBe("shared context");

    const createPlan = planReviewIntent(
      state,
      {
        type: "note/create-user",
        fileKey: file.key,
        hunkIndex: 0,
        side: "old",
        line: contextLine,
        body: "context note",
      },
      { noteId: "user:context", timestamp: "2026-01-01T00:00:00.000Z" },
    );
    const stored = requireCreatedOutcome(createPlan);
    expect(stored.note.anchor).toMatchObject({
      oldRange: [contextLine, contextLine],
      preferred: { side: "old", line: contextLine },
      ownerHunkIndex: 0,
    });
    expect(stored.contextDigests).toEqual({ old: stored.contextDigest! });

    const selectionPlan = planReviewIntent(state, {
      type: "selection/set-line",
      fileKey: file.key,
      hunkIndex: 0,
      side: "new",
      line: contextLine,
      reveal: true,
    });
    expect(selectionPlan.actions[0]).toMatchObject({
      type: "selection/set-line",
      fileKey: file.key,
      hunkIndex: 0,
      side: "new",
      line: contextLine,
      contextDigest: expect.any(String),
      reveal: true,
    });
    expect(selectionPlan.outcome).toBeUndefined();
  });

  test("reserves deterministic identities across immutable, live, and user notes", () => {
    const state = createState();
    const collision = mutableNote(state, "user:same");
    state.document.files[0]!.notes.push(collision.note);
    state.liveNotes = [{ ...collision, note: { ...collision.note, id: "user:same:1" } }];
    state.userNotes = [{ ...collision, note: { ...collision.note, id: "user:same:2" } }];
    const file = state.document.files[0]!;

    const plan = planReviewIntent(
      state,
      { type: "note/create-user", ...targetIn(file), body: "next" },
      { noteId: "user:same", timestamp: "2026-01-01T00:00:00.000Z" },
    );

    expect(plan.outcome).toMatchObject({
      type: "note/created",
      note: { note: { id: "user:same:3" } },
    });
    const next = prepareReviewState(state, plan.actions);
    expect(next.userNotes.at(-1)?.note.id).toBe("user:same:3");
  });

  test("consumes the current draft target and body in one draft/save action", () => {
    const state = createState();
    const file = state.document.files[0]!;
    const target = targetIn(file, 0, "old");
    state.draftNote = {
      id: "draft:1",
      ...target,
      oldRange: [target.line, target.line],
      body: "  terminal draft  ",
    };

    const plan = planReviewIntent(
      state,
      { type: "note/create-user", consumeDraft: true },
      { noteId: "user:draft", timestamp: "2026-01-01T00:00:00.000Z" },
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: "draft/save" });
    expect(plan.outcome).toMatchObject({
      type: "note/created",
      note: {
        note: {
          summary: "terminal draft",
          anchor: { oldRange: [target.line, target.line], preferred: { side: "old" } },
        },
      },
    });

    const next = prepareReviewState(state, plan.actions);
    expect(next.stateRevision).toBe(state.stateRevision + 1);
    expect(next.draftNote).toBeNull();
    expect(next.userNotes).toHaveLength(1);
  });

  test("rejects malformed creation targets and missing facts without mutation", () => {
    const state = createState();
    const before = JSON.stringify(state);
    const file = state.document.files[0]!;
    const first = targetIn(file, 0);

    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "note/create-user", ...first, body: "   " },
          { noteId: "user:1", timestamp: "time" },
        ),
      "empty-note-body",
    );
    expectPlanningError(
      () => planReviewIntent(state, { type: "note/create-user", ...first, body: "body" }, {}),
      "missing-fact",
    );
    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "note/create-user", ...first, fileKey: "missing", body: "body" },
          { noteId: "user:1", timestamp: "time" },
        ),
      "file-not-found",
    );
    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "note/create-user", ...first, hunkIndex: 99, body: "body" },
          { noteId: "user:1", timestamp: "time" },
        ),
      "hunk-not-found",
    );
    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "note/create-user", ...first, line: 999, body: "body" },
          { noteId: "user:1", timestamp: "time" },
        ),
      "line-not-backed",
    );
    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "note/create-user", ...first, hunkIndex: 1, body: "body" },
          { noteId: "user:1", timestamp: "time" },
        ),
      "line-hunk-mismatch",
    );
    expectPlanningError(
      () =>
        planReviewIntent(
          { ...state, draftNote: null },
          { type: "note/create-user", consumeDraft: true },
          { noteId: "user:1", timestamp: "time" },
        ),
      "draft-missing",
    );
    expect(JSON.stringify(state)).toBe(before);
  });

  test("updates editable active, stale, and orphaned notes with markup tri-state semantics", () => {
    const base = createState();
    for (const resolution of ["active", "stale", "orphaned"] as const) {
      for (const [markup, expectedMarkup] of [
        [undefined, "<em>old</em>"],
        ["<strong>new</strong>", "<strong>new</strong>"],
        ["   ", undefined],
      ] as const) {
        const existing = mutableNote(base, `user:${resolution}`, { resolution });
        existing.note.markup = "<em>old</em>";
        existing.note.title = "retained";
        existing.originalAddress = {
          documentIdentity: "source",
          fileKey: "old-key",
          path: "old.ts",
        };
        const state = { ...base, userNotes: [existing] };
        const plan = planReviewIntent(
          state,
          {
            type: "note/update-user",
            noteId: existing.note.id,
            body: "  updated  ",
            ...(markup === undefined ? {} : { markup }),
          },
          { timestamp: "2026-02-02T00:00:00.000Z" },
        );
        const outcome = plan.outcome as Extract<typeof plan.outcome, { type: "note/updated" }>;
        expect(outcome.note).toMatchObject({
          resolution,
          originalAddress: existing.originalAddress,
          contextDigest: existing.contextDigest,
          note: {
            id: existing.note.id,
            title: "retained",
            summary: "updated",
            createdAt: existing.note.createdAt,
            updatedAt: "2026-02-02T00:00:00.000Z",
            anchor: existing.note.anchor,
          },
        });
        expect(outcome.note.note.markup).toBe(expectedMarkup);
      }
    }
  });

  test("rejects absent, non-editable, and empty user-note updates", () => {
    const base = createState();
    const locked = mutableNote(base, "user:locked", { editable: false });
    const state = { ...base, userNotes: [locked] };

    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "note/update-user", noteId: "missing", body: "body" },
          { timestamp: "time" },
        ),
      "note-not-found",
    );
    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "note/update-user", noteId: locked.note.id, body: "body" },
          { timestamp: "time" },
        ),
      "note-not-editable",
    );
    const editable = mutableNote(base, "user:editable");
    expectPlanningError(
      () =>
        planReviewIntent(
          { ...base, userNotes: [editable] },
          { type: "note/update-user", noteId: editable.note.id, body: "  " },
          { timestamp: "time" },
        ),
      "empty-note-body",
    );
  });

  test("removes editable user notes regardless of reconciliation resolution", () => {
    const base = createState();
    for (const resolution of ["active", "stale", "orphaned"] as const) {
      const note = mutableNote(base, `user:${resolution}`, { resolution });
      const plan = planReviewIntent(
        { ...base, userNotes: [note] },
        { type: "note/remove-user", noteId: note.note.id },
      );
      expect(plan.actions).toEqual([
        {
          type: "notes/remove-user",
          expectedGeneration: base.documentGeneration,
          noteId: note.note.id,
        },
      ]);
    }

    const locked = mutableNote(base, "user:locked", { editable: false });
    expectPlanningError(
      () =>
        planReviewIntent(
          { ...base, userNotes: [locked] },
          { type: "note/remove-user", noteId: locked.note.id },
        ),
      "note-not-editable",
    );
    expectPlanningError(
      () => planReviewIntent(base, { type: "note/remove-user", noteId: "missing" }),
      "note-not-found",
    );
  });
});

describe("live-note compatibility intents", () => {
  test("names and preserves the existing live removal policy", () => {
    const base = createState();
    const liveAgentLocked = mutableNote(base, "mcp:live", {
      origin: "live-agent",
      editable: false,
    });
    const otherEditable = mutableNote(base, "mcp:editable", {
      origin: "sidecar",
      editable: true,
    });
    const otherLocked = mutableNote(base, "mcp:locked", {
      origin: "sidecar",
      editable: false,
    });

    expect(isLiveReviewNoteRemovable(liveAgentLocked)).toBe(true);
    expect(isLiveReviewNoteRemovable(otherEditable)).toBe(true);
    expect(isLiveReviewNoteRemovable(otherLocked)).toBe(false);

    for (const note of [liveAgentLocked, otherEditable]) {
      const plan = planReviewIntent(
        { ...base, liveNotes: [note] },
        { type: "note/remove-live", noteId: note.note.id },
      );
      expect(plan.outcome).toEqual({
        type: "note/removed",
        noteId: note.note.id,
        source: "live",
      });
    }
    expectPlanningError(
      () =>
        planReviewIntent(
          { ...base, liveNotes: [otherLocked] },
          { type: "note/remove-live", noteId: otherLocked.note.id },
        ),
      "note-not-editable",
    );
    expectPlanningError(
      () => planReviewIntent(base, { type: "note/remove-live", noteId: "missing" }),
      "note-not-found",
    );
  });
});

describe("semantic selection and shared state intents", () => {
  test("plans exact hunk and line selections with canonical evidence", () => {
    const state = createState();
    const file = state.document.files[0]!;
    const target = targetIn(file, 1, "old");
    const hunkPlan = planReviewIntent(state, {
      type: "selection/select",
      fileKey: file.key,
      hunkIndex: 1,
      reveal: { kind: "hunk", scrollToNote: true },
    });
    expect(hunkPlan.actions).toEqual([
      {
        type: "selection/select",
        selection: { fileKey: file.key, hunkIndex: 1 },
        reveal: { kind: "hunk", scrollToNote: true },
      },
    ]);

    const linePlan = planReviewIntent(state, {
      type: "selection/set-line",
      ...target,
      reveal: true,
    });
    expect(linePlan.actions[0]).toMatchObject({
      type: "selection/set-line",
      ...target,
      reveal: true,
      contextDigest: expect.any(String),
    });
    expect(linePlan.outcome).toBeUndefined();

    const preservedLine = planReviewIntent(state, {
      type: "selection/select",
      fileKey: file.key,
      hunkIndex: target.hunkIndex,
      line: { side: target.side, line: target.line },
      reveal: { kind: "file-top" },
    });
    expect(preservedLine.actions[0]).toMatchObject({
      type: "selection/select",
      selection: { ...target, contextDigest: expect.any(String) },
    });
  });

  test("rejects missing hunk targets, unbacked lines, and cross-hunk claims", () => {
    const state = createState();
    const file = state.document.files[0]!;
    const first = targetIn(file, 0);

    expectPlanningError(
      () =>
        planReviewIntent(state, {
          type: "selection/select",
          fileKey: "missing",
          hunkIndex: 0,
        }),
      "file-not-found",
    );
    expectPlanningError(
      () =>
        planReviewIntent(state, {
          type: "selection/select",
          fileKey: file.key,
          hunkIndex: 99,
        }),
      "hunk-not-found",
    );
    expectPlanningError(
      () =>
        planReviewIntent(state, {
          type: "selection/set-line",
          ...first,
          line: 999,
        }),
      "line-not-backed",
    );
    expectPlanningError(
      () =>
        planReviewIntent(state, {
          type: "selection/set-line",
          ...first,
          hunkIndex: 1,
        }),
      "line-hunk-mismatch",
    );
  });

  test("leaves filter fallback to the reducer and plans visibility as a no-op-safe action", () => {
    const firstSource = createTestDiffFile({ id: "first", path: "alpha.ts" });
    const secondSource = createTestDiffFile({ id: "second", path: "beta.ts" });
    const document = projectReviewDocument(
      { id: "filter", title: "filter", sourceLabel: "test", files: [firstSource, secondSource] },
      { generation: "generation:filter" },
    ).document;
    const state = createInitialReviewState(document);
    const filterPlan = planReviewIntent(state, { type: "filter/set", filter: "beta" });
    expect(filterPlan.actions).toEqual([{ type: "filter/set", filter: "beta" }]);
    expect(filterPlan.outcome).toBeUndefined();
    const filtered = prepareReviewState(state, filterPlan.actions);
    expect(filtered.selection.fileKey).toBe(document.files[1]!.key);

    const visibilityPlan = planReviewIntent(state, {
      type: "notes/set-visibility",
      visible: false,
    });
    expect(visibilityPlan.actions).toEqual([{ type: "notes/set-visibility", visible: false }]);
    expect(visibilityPlan.outcome).toBeUndefined();
    expect(prepareReviewState(state, visibilityPlan.actions)).toBe(state);
  });
});
