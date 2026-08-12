import { describe, expect, test } from "bun:test";
import {
  createTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../../test/helpers/diff-helpers";
import { reviewSourceLineContextDigest } from "./anchors";
import { projectReviewDocument } from "./document";
import { reviewGapAddress } from "./expansion";
import { reviewDigest } from "./identity";
import {
  isLiveReviewNoteRemovable,
  planReviewIntent,
  ReviewIntentPlanningError,
  type ReviewIntent,
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

/** Build one state whose second hunk has current, materialized expanded source. */
function createExpandedLineState() {
  const before = lines("old one", "hidden two", "hidden three", "hidden four", "old five");
  const after = lines("new one", "hidden two", "hidden three", "hidden four", "new five");
  const source = createTestDiffFile({
    before,
    after,
    context: 0,
    sourceFetcher: {
      ...createTestSourceFetcher(() => after),
      cacheKey: "source:intents-expanded",
    },
  });
  const state = createStateForSource(source);
  const file = state.document.files[0]!;
  const gapId = "before:1";
  const address = reviewGapAddress(file, gapId)!;
  const resourceId = file.sourceResourceIds.new!;
  const descriptor = state.document.resources.find(
    (resource) => resource.id === resourceId && resource.kind === "source",
  )!;
  if (descriptor.kind !== "source") throw new Error("Expected source descriptor.");
  descriptor.byteLength = Buffer.byteLength(after, "utf8");
  descriptor.digest = reviewDigest(after);
  state.expandedGaps = [
    {
      fileKey: file.key,
      gapId,
      side: "new",
      ...address,
      sourceIdentity: descriptor.sourceIdentity,
      expanded: true,
    },
  ];
  state.sourceStatusByFileKey = { [file.key]: { kind: "loaded", text: after } };
  return {
    state,
    file,
    gap: state.expandedGaps[0]!,
    proof: { gapId, sourceIdentity: descriptor.sourceIdentity },
    line: address.newRange[0],
  };
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

  test("creates source-backed notes only with current expanded-line proof", () => {
    const { state, file, proof, line } = createExpandedLineState();
    const plan = planReviewIntent(
      state,
      {
        type: "note/create-user",
        fileKey: file.key,
        hunkIndex: 1,
        side: "new",
        line,
        body: "expanded source note",
        expandedLineProof: proof,
      },
      { noteId: "user:expanded", timestamp: "2026-01-01T00:00:00.000Z" },
    );
    const stored = requireCreatedOutcome(plan);
    expect(stored.contextDigest).toBe(
      reviewSourceLineContextDigest(
        (state.sourceStatusByFileKey[file.key] as { kind: "loaded"; text: string }).text,
        line,
      ),
    );
    expect(stored.contextDigests).toEqual({ new: stored.contextDigest! });
    expect(stored.note.anchor).toEqual({
      newRange: [line, line],
      preferred: { side: "new", line },
      intersectingHunkIndices: [],
      ownerHunkIndex: 1,
    });
  });

  test("rejects missing, stale, collapsed, mismatched, and unloaded expanded-line proof", () => {
    const fixture = createExpandedLineState();
    const baseIntent: Extract<ReviewIntent, { type: "note/create-user"; consumeDraft?: false }> = {
      type: "note/create-user",
      fileKey: fixture.file.key,
      hunkIndex: 1,
      side: "new" as const,
      line: fixture.line,
      body: "expanded source note",
      expandedLineProof: fixture.proof,
    };
    const facts = { noteId: "user:expanded", timestamp: "2026-01-01T00:00:00.000Z" };
    const expectRejected = (state: ReviewState, intent = baseIntent) =>
      expectPlanningError(() => planReviewIntent(state, intent, facts), "line-not-backed");

    const { expandedLineProof: _proof, ...withoutProof } = baseIntent;
    expectRejected(fixture.state, withoutProof);
    expectRejected(fixture.state, {
      ...baseIntent,
      expandedLineProof: { ...fixture.proof, sourceIdentity: "source:stale" },
    });
    expectRejected({ ...fixture.state, expandedGaps: [] });
    expectRejected({
      ...fixture.state,
      expandedGaps: [{ ...fixture.gap, expanded: false }],
    });
    expectRejected(fixture.state, { ...baseIntent, side: "old" });
    expectPlanningError(
      () => planReviewIntent(fixture.state, { ...baseIntent, hunkIndex: 0 }, facts),
      "line-hunk-mismatch",
    );
    expectRejected({
      ...fixture.state,
      expandedGaps: [
        {
          ...fixture.gap,
          newRange: [fixture.gap.newRange[0] + 1, fixture.gap.newRange[1]],
        },
      ],
    });
    expectRejected({
      ...fixture.state,
      sourceStatusByFileKey: { [fixture.file.key]: { kind: "loading" } },
    });
    expectRejected(fixture.state, { ...baseIntent, line: fixture.gap.newRange[1] + 1 });
    expectRejected({
      ...fixture.state,
      document: {
        ...fixture.state.document,
        resources: fixture.state.document.resources.filter(
          (resource) => resource.id !== fixture.file.sourceResourceIds.new,
        ),
      },
    });
    expectRejected({
      ...fixture.state,
      document: {
        ...fixture.state.document,
        resources: fixture.state.document.resources.map((resource) => {
          if (resource.id !== fixture.file.sourceResourceIds.new || resource.kind !== "source") {
            return resource;
          }
          const {
            byteLength: _byteLength,
            digest: _digest,
            ...unmaterializedDescriptor
          } = resource;
          return unmaterializedDescriptor;
        }),
      },
    });
    expectRejected({
      ...fixture.state,
      document: {
        ...fixture.state.document,
        resources: fixture.state.document.resources.map((resource) =>
          resource.id === fixture.file.sourceResourceIds.new
            ? { ...resource, byteLength: resource.byteLength! + 1 }
            : resource,
        ),
      },
    });
    expectRejected({
      ...fixture.state,
      document: {
        ...fixture.state.document,
        resources: fixture.state.document.resources.map((resource) =>
          resource.id === fixture.file.sourceResourceIds.new
            ? { ...resource, digest: reviewDigest("different source") }
            : resource,
        ),
      },
    });
    expectRejected({
      ...fixture.state,
      sourceStatusByFileKey: {
        [fixture.file.key]: { kind: "loaded", text: "different source" },
      },
    });
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

describe("semantic live-agent note intents", () => {
  const timestamp = "2026-03-04T05:06:07.000Z";

  test("constructs one canonical batch while preserving raw optional agent fields", () => {
    const state = createState();
    const file = state.document.files[0]!;
    const target = targetIn(file, 1, "new");
    const input = {
      noteId: "mcp:canonical",
      ...target,
      summary: "  raw summary  ",
      rationale: "  raw rationale  ",
      markup: "<box>raw</box>",
      author: "agent-name",
      createdAt: timestamp,
    };
    const plan = planReviewIntent(state, {
      type: "note/create-live-agent-batch",
      notes: [input],
    });

    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action).toMatchObject({
      type: "notes/add-live",
      expectedGeneration: state.documentGeneration,
      notes: [
        {
          note: {
            id: "mcp:canonical",
            source: "agent",
            origin: "live-agent",
            originalSource: "mcp",
            fileKey: file.key,
            summary: "  raw summary  ",
            rationale: "  raw rationale  ",
            markup: "<box>raw</box>",
            author: "agent-name",
            createdAt: timestamp,
            editable: false,
            tags: ["mcp"],
            confidence: "high",
            anchor: {
              newRange: [target.line, target.line],
              preferred: { side: "new", line: target.line },
              intersectingHunkIndices: [1],
              ownerHunkIndex: 1,
            },
          },
          contextDigest: expect.any(String),
          contextDigests: { new: expect.any(String) },
          resolution: "active",
        },
      ],
    });
  });

  test("validates a complete batch before producing ordered reveal actions", () => {
    const state = createState();
    const file = state.document.files[0]!;
    const first = {
      noteId: "mcp:first",
      ...targetIn(file, 0, "old"),
      summary: "first",
      createdAt: timestamp,
    };
    const second = {
      noteId: "mcp:second",
      ...targetIn(file, 1, "new"),
      summary: "second",
      createdAt: timestamp,
    };
    const plan = planReviewIntent(state, {
      type: "note/create-live-agent-batch",
      notes: [first, second],
      reveal: { fileKey: file.key, hunkIndex: 0 },
    });
    expect(plan.actions.map((action) => action.type)).toEqual([
      "notes/add-live",
      "notes/set-visibility",
      "selection/select",
    ]);
    expect(plan.actions[2]).toMatchObject({
      type: "selection/select",
      selection: { fileKey: file.key, hunkIndex: 0 },
      reveal: { kind: "hunk", scrollToNote: true },
    });

    expectPlanningError(
      () =>
        planReviewIntent(state, {
          type: "note/create-live-agent-batch",
          notes: [first, { ...second, hunkIndex: 0 }],
        }),
      "line-hunk-mismatch",
    );
  });

  test("accepts backed addition, deletion, context, and partial-patch targets", () => {
    const fixtures = [
      {
        source: createTestDiffFile({ before: "", after: lines("added"), context: 0 }),
        side: "new" as const,
      },
      {
        source: createTestDiffFile({ before: lines("removed"), after: "", context: 0 }),
        side: "old" as const,
      },
      {
        source: createTestDiffFile({
          before: lines("old", "context"),
          after: lines("new", "context"),
          context: 1,
        }),
        side: "new" as const,
        contextLine: 2,
      },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const state = createStateForSource(fixture.source);
      const file = state.document.files[0]!;
      if (index === fixtures.length - 1) file.flags.partial = true;
      const target = {
        fileKey: file.key,
        hunkIndex: 0,
        side: fixture.side,
        line:
          fixture.contextLine ??
          (fixture.side === "new" ? file.hunks[0]!.additionStart : file.hunks[0]!.deletionStart),
      };
      expect(
        planReviewIntent(state, {
          type: "note/create-live-agent-batch",
          notes: [
            { noteId: `mcp:case:${index}`, ...target, summary: "case", createdAt: timestamp },
          ],
        }).actions[0],
      ).toMatchObject({ type: "notes/add-live" });
    }
  });

  test("plans trusted locked mutable-note removal and exact resolved clears", () => {
    const state = createState();
    const locked = mutableNote(state, "sidecar:locked", {
      origin: "sidecar",
      editable: false,
    });
    const lockedUser = mutableNote(state, "user:locked", { editable: false });
    state.liveNotes = [locked];
    state.userNotes = [lockedUser];
    expectPlanningError(
      () => planReviewIntent(state, { type: "note/remove-live", noteId: locked.note.id }),
      "note-not-editable",
    );
    expect(
      planReviewIntent(state, {
        type: "note/remove-live",
        noteId: locked.note.id,
        policy: "trusted-agent",
      }).actions,
    ).toEqual([
      {
        type: "notes/remove-live",
        expectedGeneration: state.documentGeneration,
        noteId: locked.note.id,
      },
    ]);
    expectPlanningError(
      () => planReviewIntent(state, { type: "note/remove-user", noteId: lockedUser.note.id }),
      "note-not-editable",
    );
    expect(
      planReviewIntent(state, {
        type: "note/remove-user",
        noteId: lockedUser.note.id,
        policy: "trusted-agent",
      }).actions,
    ).toEqual([
      {
        type: "notes/remove-user",
        expectedGeneration: state.documentGeneration,
        noteId: lockedUser.note.id,
      },
    ]);

    expect(
      planReviewIntent(state, {
        type: "notes/clear-resolved",
        liveNoteIds: [locked.note.id, locked.note.id],
        userNoteIds: [lockedUser.note.id],
        includeUser: true,
      }).actions,
    ).toEqual([
      {
        type: "notes/clear-live",
        expectedGeneration: state.documentGeneration,
        noteIds: [locked.note.id],
        userNoteIds: [lockedUser.note.id],
        includeUser: true,
      },
    ]);
  });

  test("rejects missing and unbacked targets without producing partial actions", () => {
    const state = createState();
    const file = state.document.files[0]!;
    const valid = {
      noteId: "mcp:valid",
      ...targetIn(file),
      summary: "valid",
      createdAt: timestamp,
    };
    expectPlanningError(
      () =>
        planReviewIntent(state, {
          type: "note/create-live-agent-batch",
          notes: [valid, { ...valid, noteId: "mcp:invalid", line: 999 }],
        }),
      "line-not-backed",
    );
    expectPlanningError(
      () =>
        planReviewIntent(state, {
          type: "note/create-live-agent-batch",
          notes: [{ ...valid, fileKey: "missing" }],
        }),
      "file-not-found",
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
  test("plans proven expanded-source line selections with full-source evidence", () => {
    const { state, file, proof, line } = createExpandedLineState();
    const plan = planReviewIntent(state, {
      type: "selection/set-line",
      fileKey: file.key,
      hunkIndex: 1,
      side: "new",
      line,
      expandedLineProof: proof,
      reveal: true,
    });
    expect(plan.actions[0]).toMatchObject({
      type: "selection/set-line",
      fileKey: file.key,
      hunkIndex: 1,
      side: "new",
      line,
      contextDigest: expect.any(String),
      reveal: true,
    });
    expectPlanningError(
      () =>
        planReviewIntent(state, {
          type: "selection/set-line",
          fileKey: file.key,
          hunkIndex: 1,
          side: "new",
          line,
        }),
      "line-not-backed",
    );
  });

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

  test("keeps hunkless files selectable only at their canonical file-level index", () => {
    const state = createState();
    const file = { ...state.document.files[0]!, hunks: [] };
    const hunkless = { ...state, document: { ...state.document, files: [file] } };

    expect(
      planReviewIntent(hunkless, {
        type: "selection/select",
        fileKey: file.key,
        hunkIndex: 0,
        reveal: { kind: "file-top" },
      }).actions,
    ).toEqual([
      {
        type: "selection/select",
        selection: { fileKey: file.key, hunkIndex: 0 },
        reveal: { kind: "file-top" },
      },
    ]);
    expectPlanningError(
      () =>
        planReviewIntent(hunkless, {
          type: "selection/select",
          fileKey: file.key,
          hunkIndex: 1,
        }),
      "hunk-not-found",
    );
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

/** Build one expansion-ready state without materializing its source. */
function createExpansionPlanState() {
  const text = lines("old one", "hidden two", "hidden three", "hidden four", "old five");
  const next = lines("new one", "hidden two", "hidden three", "hidden four", "new five");
  const state = createStateForSource(
    createTestDiffFile({
      before: text,
      after: next,
      context: 0,
      sourceFetcher: {
        ...createTestSourceFetcher(() => next),
        cacheKey: "source:expansion-plan",
      },
    }),
  );
  const file = state.document.files[0]!;
  return { state, file, gapId: "before:1", sourceText: next };
}

describe("semantic expansion intents", () => {
  const fetcherFacts = { sourceFetcherIdentity: "fetcher:test" };

  test("atomically plans expansion and loading before emitting one guarded effect", () => {
    const { state, file, gapId } = createExpansionPlanState();
    const address = reviewGapAddress(file, gapId)!;
    const descriptor = state.document.resources.find(
      (resource) => resource.id === file.sourceResourceIds.new,
    )!;
    const plan = planReviewIntent(
      state,
      { type: "expansion/toggle", fileKey: file.key, gapId },
      fetcherFacts,
    );

    expect(plan.actions).toEqual([
      {
        type: "expansion/toggle",
        expectedGeneration: state.documentGeneration,
        gap: {
          fileKey: file.key,
          gapId,
          side: "new",
          oldRange: [...address.oldRange],
          newRange: [...address.newRange],
          sourceIdentity: "source:expansion-plan",
          expanded: true,
        },
      },
      {
        type: "expansion/set-source-status",
        expectedGeneration: state.documentGeneration,
        fileKey: file.key,
        status: { kind: "loading" },
      },
    ]);
    expect(plan.effects).toEqual([
      {
        type: "source/load",
        generation: state.documentGeneration,
        fileKey: file.key,
        side: "new",
        gapId,
        oldRange: [...address.oldRange],
        newRange: [...address.newRange],
        sourceIdentity: "source:expansion-plan",
        resourceId: descriptor.id,
        sourceFetcherIdentity: "fetcher:test",
      },
    ]);
    expect(prepareReviewState(state, plan.actions).stateRevision).toBe(state.stateRevision + 1);
  });

  test("reuses loaded and loading source while retrying error state", () => {
    const loading = createExpansionPlanState();
    loading.state.sourceStatusByFileKey[loading.file.key] = { kind: "loading" };
    const loadingPlan = planReviewIntent(
      loading.state,
      { type: "expansion/toggle", fileKey: loading.file.key, gapId: loading.gapId },
      {},
    );
    expect(loadingPlan.actions).toHaveLength(1);
    expect(loadingPlan.effects).toBeUndefined();

    const loaded = createExpansionPlanState();
    const loadedDescriptor = loaded.state.document.resources.find(
      (resource) => resource.id === loaded.file.sourceResourceIds.new,
    );
    if (!loadedDescriptor || loadedDescriptor.kind !== "source") {
      throw new Error("Expected source descriptor.");
    }
    loadedDescriptor.byteLength = Buffer.byteLength(loaded.sourceText, "utf8");
    loadedDescriptor.digest = reviewDigest(loaded.sourceText);
    loaded.state.sourceStatusByFileKey[loaded.file.key] = {
      kind: "loaded",
      text: loaded.sourceText,
    };
    const loadedPlan = planReviewIntent(
      loaded.state,
      { type: "expansion/toggle", fileKey: loaded.file.key, gapId: loaded.gapId },
      {},
    );
    expect(loadedPlan.actions).toHaveLength(1);
    expect(loadedPlan.effects).toBeUndefined();

    const { state, file, gapId } = createExpansionPlanState();
    state.sourceStatusByFileKey[file.key] = { kind: "error", reason: "too-large" };
    const retried = planReviewIntent(
      state,
      { type: "expansion/toggle", fileKey: file.key, gapId },
      fetcherFacts,
    );
    expect(retried.actions[1]).toMatchObject({
      type: "expansion/set-source-status",
      status: { kind: "loading" },
    });
    expect(retried.effects).toHaveLength(1);
  });

  test("uses old-side source authority for deleted files", () => {
    const fixture = createExpansionPlanState();
    const deleted = {
      ...fixture.state,
      document: {
        ...fixture.state.document,
        files: [{ ...fixture.file, changeKind: "deleted" as const }],
      },
    };
    const plan = planReviewIntent(
      deleted,
      { type: "expansion/toggle", fileKey: fixture.file.key, gapId: fixture.gapId },
      fetcherFacts,
    );
    expect(plan.actions[0]).toMatchObject({ type: "expansion/toggle", gap: { side: "old" } });
    expect(plan.effects?.[0]).toMatchObject({
      type: "source/load",
      side: "old",
      resourceId: fixture.file.sourceResourceIds.old,
    });
  });

  test("rejects invalid file, gap, resource, and missing fetcher fact", () => {
    const { state, file, gapId } = createExpansionPlanState();
    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "expansion/toggle", fileKey: "missing", gapId },
          fetcherFacts,
        ),
      "file-not-found",
    );
    expectPlanningError(
      () =>
        planReviewIntent(
          state,
          { type: "expansion/toggle", fileKey: file.key, gapId: "before:99" },
          fetcherFacts,
        ),
      "gap-not-found",
    );
    expectPlanningError(
      () =>
        planReviewIntent(
          {
            ...state,
            document: {
              ...state.document,
              resources: state.document.resources.filter(
                (resource) => resource.id !== file.sourceResourceIds.new,
              ),
            },
          },
          { type: "expansion/toggle", fileKey: file.key, gapId },
          fetcherFacts,
        ),
      "source-unavailable",
    );
    expectPlanningError(
      () => planReviewIntent(state, { type: "expansion/toggle", fileKey: file.key, gapId }),
      "missing-fact",
    );
  });

  test("collapses without effects and repairs only a proven hidden selection", () => {
    const { state, file, gap, proof, line } = createExpandedLineState();
    state.selection = {
      fileKey: file.key,
      hunkIndex: 1,
      side: "new",
      line,
      contextDigest: reviewSourceLineContextDigest(
        (state.sourceStatusByFileKey[file.key] as { kind: "loaded"; text: string }).text,
        line,
      ),
    };
    const plan = planReviewIntent(state, {
      type: "expansion/toggle",
      fileKey: file.key,
      gapId: proof.gapId,
    });
    expect(plan.effects).toBeUndefined();
    expect(plan.actions[0]).toMatchObject({
      type: "expansion/toggle",
      gap: { ...gap, expanded: false },
    });
    expect(plan.actions[1]).toMatchObject({
      type: "selection/set-line",
      fileKey: file.key,
      hunkIndex: 1,
      side: "new",
      line: file.hunks[1]!.additionStart,
      contextDigest: expect.any(String),
    });

    const unrelated = planReviewIntent(
      { ...state, selection: { fileKey: file.key, hunkIndex: 0 } },
      { type: "expansion/toggle", fileKey: file.key, gapId: proof.gapId },
    );
    expect(unrelated.actions).toHaveLength(1);
  });
});
