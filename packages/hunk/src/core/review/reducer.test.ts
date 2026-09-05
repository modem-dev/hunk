import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import { reduceReviewState } from "./reducer";
import type { ReviewState } from "./state";

/** Apply several actions in order, as one dispatch batch would. */
function reduceAll(state: ReviewState, ...actions: Parameters<typeof reduceReviewState>[1][]) {
  return actions.reduce(reduceReviewState, state);
}

describe("selection", () => {
  test("clamps the hunk index into the addressed file", () => {
    const next = reduceReviewState(createTestReviewState([{ key: "alpha", hunkCount: 2 }]), {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 7,
    });

    expect(next.selection).toEqual({ fileKey: "alpha", hunkIndex: 1 });
  });

  test("keeps a file with no hunks selectable", () => {
    const next = reduceReviewState(createTestReviewState([{ key: "alpha", hunkCount: 0 }]), {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 3,
    });

    expect(next.selection).toEqual({ fileKey: "alpha", hunkIndex: 0 });
  });

  test("ignores a selection of a file the review does not contain", () => {
    const state = createTestReviewState();

    expect(
      reduceReviewState(state, {
        type: "selection/select",
        fileKey: "missing",
        hunkIndex: 0,
      }),
    ).toBe(state);
  });

  test("advances only the reveal counter the requested anchor belongs to", () => {
    const state = createTestReviewState();
    const hunkRevealed = reduceReviewState(state, {
      type: "selection/select",
      fileKey: "beta",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
    });
    const fileRevealed = reduceReviewState(hunkRevealed, {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "file-top", scrollToNote: false },
    });

    expect(hunkRevealed.reveal).toEqual({ fileTopToken: 0, hunkToken: 1, scrollToNote: false });
    expect(fileRevealed.reveal).toEqual({ fileTopToken: 1, hunkToken: 1, scrollToNote: false });
  });

  test("re-reveals the same target so a repeated request still scrolls", () => {
    const state = createTestReviewState();
    const first = reduceReviewState(state, {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
    });
    const second = reduceReviewState(first, {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
    });

    expect(second.reveal.hunkToken).toBe(first.reveal.hunkToken + 1);
  });

  test("leaves the viewport alone when no reveal anchor is named", () => {
    const state = createTestReviewState();
    const next = reduceReviewState(state, {
      type: "selection/select",
      fileKey: "beta",
      hunkIndex: 1,
      reveal: { anchor: "none", scrollToNote: false },
    });

    expect(next.selection).toEqual({ fileKey: "beta", hunkIndex: 1 });
    expect(next.reveal).toEqual(state.reveal);
  });

  test("retires a note-scroll request even when the selection is unchanged", () => {
    const noteSelected = reduceReviewState(createTestReviewState(), {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: true },
    });
    const anchored = reduceReviewState(noteSelected, {
      type: "selection/select",
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "none", scrollToNote: false },
    });

    expect(anchored.reveal.scrollToNote).toBe(false);
    expect(anchored.reveal.hunkToken).toBe(noteSelected.reveal.hunkToken);
  });
});

describe("document reconciliation", () => {
  test("drops expansion and loaded source for a file whose source identity changed", () => {
    const state = reduceAll(
      createTestReviewState([
        { key: "alpha", sourceIdentity: "source-1", sourceAttested: true },
        { key: "beta", sourceIdentity: "source-1", sourceAttested: true },
      ]),
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: true },
      { type: "expansion/toggle", fileKey: "beta", gapId: "before:1", expanded: true },
      {
        type: "expansion/set-source-status",
        fileKey: "alpha",
        status: { kind: "loaded", text: "a" },
      },
      {
        type: "expansion/set-source-status",
        fileKey: "beta",
        status: { kind: "loaded", text: "b" },
      },
    );

    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: createTestReviewDocument([
        { key: "alpha", sourceIdentity: "source-2", sourceAttested: true },
        { key: "beta", sourceIdentity: "source-1", sourceAttested: true },
      ]),
    });

    expect(next.expandedGaps).toEqual([{ fileKey: "beta", gapId: "before:1", expanded: true }]);
    expect(next.sourceStatusByFileKey).toEqual({ beta: { kind: "loaded", text: "b" } });
  });

  test("drops unattested loaded source on reconcile while keeping the gap open", () => {
    const state = reduceAll(
      createTestReviewState([{ key: "alpha", sourceIdentity: "source-1" }]),
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: true },
      {
        type: "expansion/set-source-status",
        fileKey: "alpha",
        status: { kind: "loaded", text: "a" },
      },
    );

    // Same identity, but no reader attestation: the diff not moving proves nothing about
    // the full source behind it, so the cached text goes and the open gap refetches.
    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: createTestReviewDocument([{ key: "alpha", sourceIdentity: "source-1" }]),
    });

    expect(next.expandedGaps).toEqual([{ fileKey: "alpha", gapId: "before:1", expanded: true }]);
    expect(next.sourceStatusByFileKey).toEqual({});
  });

  test("drops file-scoped state for a file the new document retired", () => {
    const state = reduceReviewState(createTestReviewState(["alpha", "beta"]), {
      type: "expansion/toggle",
      fileKey: "beta",
      gapId: "before:1",
      expanded: true,
    });

    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: createTestReviewDocument(["alpha"]),
    });

    expect(next.expandedGaps).toEqual([]);
  });

  test("keeps notes and the active draft across a reload", () => {
    const state = reduceAll(
      createTestReviewState(),
      { type: "notes/add-live", notes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })] },
      {
        type: "draft/start",
        draft: {
          id: "draft-1",
          fileKey: "alpha",
          hunkIndex: 0,
          side: "new",
          line: 4,
          body: "wip",
        },
      },
    );

    const next = reduceReviewState(state, {
      type: "document/reconcile",
      document: createTestReviewDocument(["alpha", "beta"]),
    });

    expect(next.liveNotes).toHaveLength(1);
    expect(next.draftNote?.body).toBe("wip");
  });
});

describe("notes", () => {
  test("appends live notes in arrival order and removes them by id", () => {
    const added = reduceReviewState(createTestReviewState(), {
      type: "notes/add-live",
      notes: [
        createTestStoredNote({ id: "live-1", fileKey: "alpha" }),
        createTestStoredNote({ id: "live-2", fileKey: "beta" }),
      ],
    });
    const removed = reduceReviewState(added, { type: "notes/remove-live", noteId: "live-1" });

    expect(added.liveNotes.map((entry) => entry.note.id)).toEqual(["live-1", "live-2"]);
    expect(removed.liveNotes.map((entry) => entry.note.id)).toEqual(["live-2"]);
  });

  test("ignores removal of an unknown note", () => {
    const state = createTestReviewState();

    expect(reduceReviewState(state, { type: "notes/remove-live", noteId: "nope" })).toBe(state);
  });

  test("clears one file's live notes while leaving user notes alone", () => {
    const state = reduceAll(
      createTestReviewState(),
      {
        type: "notes/add-live",
        notes: [
          createTestStoredNote({ id: "live-1", fileKey: "alpha" }),
          createTestStoredNote({ id: "live-2", fileKey: "beta" }),
        ],
      },
      {
        type: "draft/start",
        draft: { id: "d", fileKey: "alpha", hunkIndex: 0, side: "new", line: 1, body: "x" },
      },
      {
        type: "draft/save",
        note: createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" }),
      },
    );

    const cleared = reduceReviewState(state, { type: "notes/clear", fileKey: "alpha" });

    expect(cleared.liveNotes.map((entry) => entry.note.id)).toEqual(["live-2"]);
    expect(cleared.userNotes.map((entry) => entry.note.id)).toEqual(["user-1"]);
  });

  test("clears user notes too when the caller asks for them", () => {
    const state = reduceAll(
      createTestReviewState(),
      { type: "notes/add-live", notes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })] },
      {
        type: "draft/start",
        draft: { id: "d", fileKey: "alpha", hunkIndex: 0, side: "new", line: 1, body: "x" },
      },
      {
        type: "draft/save",
        note: createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" }),
      },
    );

    const cleared = reduceReviewState(state, { type: "notes/clear", includeUser: true });

    expect(cleared.liveNotes).toEqual([]);
    expect(cleared.userNotes).toEqual([]);
  });
});

describe("drafts", () => {
  const draft = {
    id: "draft-1",
    fileKey: "alpha",
    hunkIndex: 0,
    side: "new" as const,
    line: 4,
    newRange: [4, 4] as [number, number],
    body: "",
  };

  test("edits and cancels the active draft", () => {
    const started = reduceReviewState(createTestReviewState(), { type: "draft/start", draft });
    const edited = reduceReviewState(started, { type: "draft/update", body: "hello" });
    const cancelled = reduceReviewState(edited, { type: "draft/cancel" });

    expect(edited.draftNote?.body).toBe("hello");
    expect(cancelled.draftNote).toBeNull();
  });

  test("ignores edits with no draft in progress", () => {
    const state = createTestReviewState();

    expect(reduceReviewState(state, { type: "draft/update", body: "hello" })).toBe(state);
    expect(reduceReviewState(state, { type: "draft/cancel" })).toBe(state);
  });

  test("saving retires the draft and appends one user note", () => {
    const started = reduceReviewState(createTestReviewState(), { type: "draft/start", draft });
    const saved = reduceReviewState(started, {
      type: "draft/save",
      note: createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" }),
    });

    expect(saved.draftNote).toBeNull();
    expect(saved.userNotes.map((entry) => entry.note.id)).toEqual(["user-1"]);
  });

  test("saving an edit replaces the note in place", () => {
    const original = createTestStoredNote({ id: "user-1", fileKey: "alpha", source: "user" });
    const state = {
      ...createTestReviewState(),
      userNotes: [
        original,
        createTestStoredNote({ id: "user-2", fileKey: "alpha", source: "user" }),
      ],
      draftNote: { ...draft, kind: "edit" as const, targetNoteId: "user-1" },
    };
    const replacement = { ...original, note: { ...original.note, summary: "updated" } };
    const saved = reduceReviewState(state, { type: "draft/save-edit", note: replacement });

    expect(saved.draftNote).toBeNull();
    expect(saved.userNotes.map(({ note }) => [note.id, note.summary])).toEqual([
      ["user-1", "updated"],
      ["user-2", "note user-2"],
    ]);
  });
});

describe("expansion", () => {
  test("collapses a gap without forgetting the other gaps of the file", () => {
    const state = reduceAll(
      createTestReviewState(),
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: true },
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:2", expanded: true },
      { type: "expansion/toggle", fileKey: "alpha", gapId: "before:1", expanded: false },
    );

    expect(state.expandedGaps).toEqual([
      { fileKey: "alpha", gapId: "before:1", expanded: false },
      { fileKey: "alpha", gapId: "before:2", expanded: true },
    ]);
  });

  test("ignores a toggle that repeats the current expansion", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "expansion/toggle",
      fileKey: "alpha",
      gapId: "before:1",
      expanded: true,
    });

    expect(
      reduceReviewState(state, {
        type: "expansion/toggle",
        fileKey: "alpha",
        gapId: "before:1",
        expanded: true,
      }),
    ).toBe(state);
  });

  test("compares source status by value so a repeated load does not re-render", () => {
    const state = reduceReviewState(createTestReviewState(), {
      type: "expansion/set-source-status",
      fileKey: "alpha",
      status: { kind: "loaded", text: "source" },
    });

    expect(
      reduceReviewState(state, {
        type: "expansion/set-source-status",
        fileKey: "alpha",
        status: { kind: "loaded", text: "source" },
      }),
    ).toBe(state);
    expect(
      reduceReviewState(state, {
        type: "expansion/set-source-status",
        fileKey: "alpha",
        status: { kind: "loaded", text: "changed" },
      }),
    ).not.toBe(state);
  });
});

describe("filter and note visibility", () => {
  test("sets the shared filter without touching selection", () => {
    const state = createTestReviewState();
    const next = reduceReviewState(state, { type: "filter/set", filter: "alpha" });

    expect(next.filter).toBe("alpha");
    expect(next.selection).toEqual(state.selection);
  });

  test("ignores a repeated filter or visibility value", () => {
    const state = createTestReviewState();

    expect(reduceReviewState(state, { type: "filter/set", filter: "" })).toBe(state);
    expect(reduceReviewState(state, { type: "notes/set-visibility", visible: false })).toBe(state);
    expect(
      reduceReviewState(state, { type: "notes/set-visibility", visible: true }).showAgentNotes,
    ).toBe(true);
  });
});
