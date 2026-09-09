import { describe, expect, test } from "bun:test";
import {
  createTestReviewState,
  createTestStoredNote,
} from "../../../../test/helpers/review-store-helpers";
import {
  buildExtensionReviewSnapshot,
  diffExtensionReviewNotes,
  projectExtensionReviewNotes,
} from "./reviewSnapshot";

describe("buildExtensionReviewSnapshot", () => {
  test("projects every saved note and stable file identity without including drafts", () => {
    const live = createTestStoredNote({
      id: "live:1",
      fileKey: "alpha",
      line: 2,
      resolution: "stale",
      summary: "Check this edge case.",
    });
    live.note.originalSource = "mcp";
    live.note.rationale = "The fallback changes behavior.";
    live.note.tags = ["correctness"];
    live.note.confidence = "high";
    live.note.createdAt = "2026-08-19T12:00:00.000Z";

    const user = createTestStoredNote({
      id: "user:1",
      fileKey: "retired-file",
      source: "user",
      resolution: "orphaned",
      summary: "Keep this even when its file disappears.",
    });
    user.note.editable = true;
    user.note.anchor = {
      oldRange: [4, 4],
      preferred: { side: "old", line: 4 },
      intersectingHunkIndices: [],
      ownerHunkIndex: 0,
    };
    user.note.markup = "<b>Keep this</b>";
    user.note.title = "Retired finding";
    user.note.author = "reviewer";
    user.note.updatedAt = "2026-08-19T13:00:00.000Z";

    const initial = createTestReviewState([
      {
        key: "alpha",
        path: "src/alpha.ts",
        contentIdentity: "sha256:alpha",
        sourceIdentity: "git:alpha",
        sourceAttested: true,
      },
    ]);
    const state = {
      ...initial,
      document: {
        files: [
          {
            ...initial.document.files[0]!,
            previousPath: "src/old-alpha.ts",
            changeKind: "rename-changed" as const,
          },
        ],
      },
      stateRevision: 7,
      liveNotes: [live],
      userNotes: [user],
      draftNote: {
        id: "draft:1",
        fileKey: "alpha",
        hunkIndex: 0,
        side: "new" as const,
        line: 3,
        body: "unfinished",
      },
    };

    const snapshot = buildExtensionReviewSnapshot("producer:4", state);

    expect(snapshot).toEqual({
      generation: "producer:4",
      stateRevision: 7,
      files: [
        {
          fileKey: "alpha",
          runtimeId: "alpha",
          path: "src/alpha.ts",
          previousPath: "src/old-alpha.ts",
          changeKind: "rename-changed",
          stats: { additions: 2, deletions: 2, truncated: false },
          flags: { untracked: false, binary: false, tooLarge: false, partial: false },
          contentIdentity: "sha256:alpha",
          sourceIdentity: "git:alpha",
          sourceAttested: true,
        },
      ],
      notes: [
        {
          id: "live:1",
          source: "agent",
          originalSource: "mcp",
          fileKey: "alpha",
          anchor: {
            newRange: [2, 2],
            preferred: { side: "new", line: 2 },
            intersectingHunkIndices: [0],
            ownerHunkIndex: 0,
          },
          summary: "Check this edge case.",
          rationale: "The fallback changes behavior.",
          createdAt: "2026-08-19T12:00:00.000Z",
          editable: false,
          tags: ["correctness"],
          confidence: "high",
          resolution: "stale",
        },
        {
          id: "user:1",
          source: "user",
          fileKey: "retired-file",
          anchor: {
            oldRange: [4, 4],
            preferred: { side: "old", line: 4 },
            intersectingHunkIndices: [],
            ownerHunkIndex: 0,
          },
          summary: "Keep this even when its file disappears.",
          markup: "<b>Keep this</b>",
          title: "Retired finding",
          author: "reviewer",
          updatedAt: "2026-08-19T13:00:00.000Z",
          editable: true,
          resolution: "orphaned",
        },
      ],
    });
    expect(snapshot.notes.some((note) => note.id === "draft:1")).toBe(false);
  });

  test("copies and freezes nested public data without freezing or mutating ReviewStore state", () => {
    const entry = createTestStoredNote({ id: "live:1", fileKey: "alpha", line: 2 });
    entry.note.tags = ["one"];
    const state = { ...createTestReviewState(["alpha"]), liveNotes: [entry] };

    const snapshot = buildExtensionReviewSnapshot("producer:1", state);
    const note = snapshot.notes[0]!;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
    expect(Object.isFrozen(snapshot.files[0])).toBe(true);
    expect(Object.isFrozen(snapshot.files[0]!.stats)).toBe(true);
    expect(Object.isFrozen(snapshot.notes)).toBe(true);
    expect(Object.isFrozen(note)).toBe(true);
    expect(Object.isFrozen(note.anchor)).toBe(true);
    expect(Object.isFrozen(note.anchor.preferred)).toBe(true);
    expect(Object.isFrozen(note.anchor.newRange)).toBe(true);
    expect(Object.isFrozen(note.anchor.intersectingHunkIndices)).toBe(true);
    expect(Object.isFrozen(note.tags)).toBe(true);

    expect(() => (note.anchor.intersectingHunkIndices as number[]).push(9)).toThrow();
    expect(() => (note.tags as string[]).push("two")).toThrow();
    expect(entry.note.anchor.intersectingHunkIndices).toEqual([0]);
    expect(entry.note.tags).toEqual(["one"]);
    expect(Object.isFrozen(entry.note)).toBe(false);
  });
});

describe("diffExtensionReviewNotes", () => {
  test("reports created, updated, and removed notes in a stable kind order", () => {
    const kept = createTestStoredNote({
      id: "keep",
      fileKey: "alpha",
      summary: "unchanged",
    });
    const updated = createTestStoredNote({
      id: "edit",
      fileKey: "alpha",
      summary: "before",
    });
    const removed = createTestStoredNote({
      id: "gone",
      fileKey: "alpha",
      summary: "leave",
    });
    const created = createTestStoredNote({
      id: "new",
      fileKey: "alpha",
      summary: "arrive",
    });
    const previous = projectExtensionReviewNotes({
      liveNotes: [kept, updated, removed],
      userNotes: [],
    });
    const next = projectExtensionReviewNotes({
      liveNotes: [kept, { ...updated, note: { ...updated.note, summary: "after" } }, created],
      userNotes: [],
    });

    expect(diffExtensionReviewNotes(previous, next)).toEqual([
      { kind: "removed", note: previous[2]! },
      { kind: "updated", note: next[1]! },
      { kind: "created", note: next[2]! },
    ]);
  });
});
