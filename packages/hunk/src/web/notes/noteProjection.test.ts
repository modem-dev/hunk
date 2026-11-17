import { describe, expect, test } from "bun:test";
import type { ReviewStoredNote } from "../../core/review/state";
import type { ReviewNote } from "../../core/review/types";
import type { ReviewSharedNote } from "../../session/reviewSharedState";
import {
  countVisibleNotesByFile,
  MAX_NOTE_THREAD_DEPTH,
  planReviewFileNotes,
  reviewComposerPlacement,
  reviewNotePlacement,
  webNoteAuthor,
} from "./noteProjection";

/** Two hunks: new lines 10–14 and 40–44. */
const FILE = {
  key: "file:a",
  hunks: [
    { additionStart: 10, additionCount: 5, deletionStart: 10, deletionCount: 5 },
    { additionStart: 40, additionCount: 5, deletionStart: 40, deletionCount: 5 },
  ],
};

/** One note on `FILE` anchored at a new-side line, owned by a hunk. */
function createTestNote(id: string, line: number, overrides: Partial<ReviewNote> = {}) {
  return {
    id,
    source: "agent",
    fileKey: FILE.key,
    anchor: {
      intersectingHunkIndices: line < 30 ? [0] : [1],
      ownerHunkIndex: line < 30 ? 0 : 1,
      newRange: [line, line],
      preferred: { side: "new", line },
    },
    summary: `note ${id}`,
    editable: false,
    ...overrides,
  } as ReviewNote;
}

/** Stored entries for the page store's state. */
function stored(...notes: ReviewNote[]): ReviewStoredNote[] {
  return notes.map((note) => ({ note, resolution: "active" }));
}

describe("reviewNotePlacement", () => {
  test("hangs a note beside its anchor line when that line is drawn", () => {
    expect(reviewNotePlacement(createTestNote("a", 12), FILE)).toEqual({ side: "new", line: 12 });
  });

  test("falls back to the owner hunk's line when the anchor sits in collapsed context", () => {
    const note = createTestNote("b", 25, {
      anchor: {
        intersectingHunkIndices: [],
        ownerHunkIndex: 1,
        newRange: [25, 25],
        preferred: { side: "new", line: 25 },
      },
    });
    expect(reviewNotePlacement(note, FILE)).toEqual({ side: "new", line: 40 });
    // Once the gap is open the line is drawn, and the note moves to it.
    const expanded = {
      key: FILE.key,
      hunks: [
        FILE.hunks[0]!,
        { additionStart: 15, additionCount: 30, deletionStart: 15, deletionCount: 30 },
      ],
    };
    expect(reviewNotePlacement(note, expanded)).toEqual({ side: "new", line: 25 });
  });
});

describe("reviewComposerPlacement", () => {
  // Intent: a composer opened on a line an expanded gap drew must stay visible once the gap is
  // collapsed, or a reload restores a draft nobody can see.
  test("keeps a drawn line and falls back to the owner hunk's line when it is not drawn", () => {
    expect(reviewComposerPlacement({ side: "new", line: 12, hunkIndex: 0 }, FILE)).toEqual({
      side: "new",
      line: 12,
    });
    expect(reviewComposerPlacement({ side: "new", line: 25, hunkIndex: 1 }, FILE)).toEqual({
      side: "new",
      line: 40,
    });
    expect(reviewComposerPlacement({ side: "new", line: 25, hunkIndex: 9 }, FILE)).toEqual({
      side: "new",
      line: 40,
    });
  });
});

describe("webNoteAuthor", () => {
  test("names a note written through the review link as a reviewer from a browser", () => {
    const fromLink = createTestNote("link", 12, {
      source: "user",
      originalSource: "browser",
      author: "user",
    });
    const [card] = planReviewFileNotes({
      file: FILE,
      state: { liveNotes: [], userNotes: stored(fromLink), showAgentNotes: false },
      sidecar: [],
    }).flatMap((group) => group.cards);
    expect(card!.author).toEqual({ kind: "person", name: "Reviewer", role: "browser" });
  });

  test("uses the author name, else the origin's word, and drops a chip that repeats it", () => {
    expect(webNoteAuthor(createTestNote("a", 12, { author: "sonnet" }))).toEqual({
      kind: "agent",
      name: "sonnet",
      role: "agent",
    });
    expect(webNoteAuthor(createTestNote("b", 12))).toEqual({ kind: "agent", name: "Agent" });
    expect(webNoteAuthor(createTestNote("c", 12, { source: "user", author: "user" }))).toEqual({
      kind: "person",
      name: "Reviewer",
    });
    expect(
      webNoteAuthor(
        createTestNote("d", 12, { source: "user", originalSource: "browser", author: "Ana" }),
      ),
    ).toEqual({ kind: "person", name: "Ana", role: "browser" });
  });
});

describe("planReviewFileNotes", () => {
  test("lists sidecar notes first, then threads, replies under their root with capped depth", () => {
    const root = createTestNote("root", 12);
    const replies = Array.from({ length: 5 }, (_unused, index) =>
      createTestNote(`reply-${index}`, 12, {
        parentId: index === 0 ? "root" : `reply-${index - 1}`,
      }),
    );
    const sidecar: ReviewSharedNote[] = [
      {
        note: createTestNote("side", 12, { source: "ai" }),
        resolution: "active",
        origin: "sidecar",
      },
    ];
    const groups = planReviewFileNotes({
      file: FILE,
      state: { liveNotes: stored(root, ...replies), userNotes: [], showAgentNotes: true },
      sidecar,
      now: 0,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.cards.map((card) => [card.id, card.threadId, card.depth])).toEqual([
      ["side", "side", 0],
      ["root", "root", 0],
      ["reply-0", "root", 1],
      ["reply-1", "root", 2],
      ["reply-2", "root", MAX_NOTE_THREAD_DEPTH],
      ["reply-3", "root", MAX_NOTE_THREAD_DEPTH],
      ["reply-4", "root", MAX_NOTE_THREAD_DEPTH],
    ]);
  });

  test("names authors, ages, and locations in words, and marks stale ones", () => {
    const agent = createTestNote("agent", 12, { author: "sonnet" });
    const anonymous = createTestNote("anon", 41);
    const mine = createTestNote("mine", 42, {
      source: "user",
      createdAt: new Date(0).toISOString(),
    });
    const groups = planReviewFileNotes({
      file: FILE,
      state: {
        liveNotes: [...stored(agent), { note: anonymous, resolution: "stale" }],
        userNotes: stored(mine),
        showAgentNotes: true,
      },
      sidecar: [],
      now: 5 * 60_000,
    });
    const cards = groups.flatMap((group) => group.cards);
    expect(cards.map((card) => [card.author.name, card.age, card.location, card.stale])).toEqual([
      ["sonnet", "", "line 12", false],
      ["Agent", "", "line 41", true],
      ["Reviewer", "5m", "line 42", false],
    ]);
  });

  test("hides agent notes, not the reviewer's own, when agent notes are off", () => {
    const state = {
      liveNotes: stored(createTestNote("agent", 12)),
      userNotes: stored(createTestNote("mine", 42, { source: "user" })),
      showAgentNotes: false,
    };
    const sidecar: ReviewSharedNote[] = [
      { note: createTestNote("side", 13), resolution: "active", origin: "sidecar" },
    ];
    const ids = planReviewFileNotes({ file: FILE, state, sidecar }).flatMap((group) =>
      group.cards.map((card) => card.id),
    );
    expect(ids).toEqual(["mine"]);
    expect(countVisibleNotesByFile(state, sidecar).get(FILE.key)).toBe(1);
    expect(countVisibleNotesByFile({ ...state, showAgentNotes: true }, sidecar).get(FILE.key)).toBe(
      3,
    );
  });
});
