import { describe, expect, test } from "bun:test";
import { MAX_REVIEW_NOTE_BYTES } from "../../core/review/noteSize";
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import type { ReviewActionOptions } from "../actions/reviewActions";
import { NoteComposerStore, type NoteComposer } from "./composerStore";
import {
  noteBodyIssue,
  noteComposerAction,
  noteRemovalAction,
  saveNoteComposer,
} from "./noteActions";

/** One composer with defaults for everything the test does not name. */
function createTestComposer(patch: Partial<NoteComposer> = {}): NoteComposer {
  return {
    key: "k",
    kind: "new",
    fileKey: "file:a",
    hunkIndex: 1,
    side: "new",
    line: 12,
    contentIdentity: "content:a",
    body: "Looks off by one.",
    status: "editing",
    ...patch,
  };
}

describe("noteBodyIssue", () => {
  test("refuses blank and oversized bodies before sending", () => {
    expect(noteBodyIssue({ fileKey: "file:a", body: "  \n " })).toBe("blank-note");
    expect(noteBodyIssue({ fileKey: "file:a", body: "x".repeat(MAX_REVIEW_NOTE_BYTES) })).toBe(
      "note-too-large",
    );
    expect(noteBodyIssue({ fileKey: "file:a", body: "fine" })).toBeUndefined();
  });
});

describe("noteComposerAction", () => {
  test("adds a new note with its target and expanded-line proof", () => {
    const proof = { gapId: "before:0", side: "new" as const, line: 3, sourceIdentity: "s" };
    expect(
      noteComposerAction(
        createTestComposer({ target: { side: "new", line: 3 }, expandedLineProof: proof }),
      ),
    ).toEqual({
      type: "notes/add-user",
      fileKey: "file:a",
      hunkIndex: 1,
      body: "Looks off by one.",
      target: { side: "new", line: 3 },
      expandedLineProof: proof,
    });
  });

  test("adds a reply under its parent and edits by note id", () => {
    expect(noteComposerAction(createTestComposer({ kind: "reply", parentId: "n1" }))).toEqual({
      type: "notes/add-user",
      fileKey: "file:a",
      hunkIndex: 1,
      body: "Looks off by one.",
      parentId: "n1",
    });
    expect(noteComposerAction(createTestComposer({ kind: "edit", noteId: "n1" }))).toEqual({
      type: "notes/edit-user",
      noteId: "n1",
      body: "Looks off by one.",
    });
  });
});

describe("noteRemovalAction", () => {
  test("removes a reviewer note and dismisses an agent's live note, as `D` does", () => {
    expect(noteRemovalAction({ id: "n1", source: "user" })).toEqual({
      type: "notes/remove-user",
      noteId: "n1",
    });
    expect(noteRemovalAction({ id: "n2", source: "agent" })).toEqual({
      type: "notes/remove-live",
      noteId: "n2",
    });
  });
});

describe("saveNoteComposer", () => {
  /** A store holding one composer, and a sender that records what it was asked. */
  function createTestSave(composer: NoteComposer, outcome: "ok" | "refused") {
    const store = new NoteComposerStore("s1", undefined);
    const key = store.open(composer);
    const calls: ReviewActionOptions[] = [];
    const sender = {
      send: async (_action: unknown, options: ReviewActionOptions = {}) => {
        calls.push(options);
        return outcome === "ok"
          ? ({ ok: true, applied: { ok: true, generation: "g1", stateRevision: 7 } } as const)
          : ({ ok: false, code: "note-has-replies", message: "refused" } as const);
      },
    };
    return {
      store,
      current: () => store.getSnapshot().find((entry) => entry.key === key)!,
      calls,
      sender,
    };
  }

  test("waits, sending, for the shared state to show the saved note", async () => {
    const { store, current, sender } = createTestSave(createTestComposer(), "ok");
    await saveNoteComposer(current(), store, sender, () => "content:a");
    expect(current()).toMatchObject({
      status: "sending",
      awaiting: { generation: "g1", stateRevision: 7 },
    });
  });

  test("shows the refusal in the composer", async () => {
    const { store, current, sender } = createTestSave(createTestComposer(), "refused");
    await saveNoteComposer(current(), store, sender, () => "content:a");
    expect(current()).toMatchObject({ status: "failed", error: "refused" });
  });

  test("words a blank body with the session's sentence without sending", async () => {
    const { store, current, sender, calls } = createTestSave(
      createTestComposer({ body: " " }),
      "ok",
    );
    await saveNoteComposer(current(), store, sender, () => "content:a");
    expect(current()).toMatchObject({ status: "failed", error: reviewErrorMessage("blank-note") });
    expect(calls).toHaveLength(0);
  });

  // Intent: a hunk index and lines mean nothing once their file changed, so a stale-generation
  // retry is allowed only while the file still has the content the note was written against.
  test("allows a stale-generation retry only while the file content is unchanged", async () => {
    let identity = "content:a";
    const { store, current, sender, calls } = createTestSave(createTestComposer(), "ok");
    await saveNoteComposer(current(), store, sender, () => identity);
    expect(calls[0]!.stillMeaningful!()).toBe(true);
    identity = "content:a2";
    expect(calls[0]!.stillMeaningful!()).toBe(false);
  });
});
