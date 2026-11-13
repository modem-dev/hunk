import { describe, expect, test } from "bun:test";
import type { ReviewStoredNote } from "../../core/review/state";
import type { ReviewNoteV1 } from "../../core/review/types";
import type { ReviewSharedNoteV1 } from "../../session/reviewSharedState";
import {
  countVisibleNotesByFile,
  MAX_NOTE_THREAD_DEPTH,
  planReviewFileNotes,
  reviewNotePlacement,
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
function createTestNote(id: string, line: number, overrides: Partial<ReviewNoteV1> = {}) {
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
  } as ReviewNoteV1;
}

/** Stored entries for the page store's state. */
function stored(...notes: ReviewNoteV1[]): ReviewStoredNote[] {
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

describe("planReviewFileNotes titles", () => {
  test("names a note written through the review link by where it came from", () => {
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
    expect(card!.title).toBe("Browser note");
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
    const sidecar: ReviewSharedNoteV1[] = [
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
    expect(groups[0]!.cards.map((card) => [card.id, card.depth])).toEqual([
      ["side", 0],
      ["root", 0],
      ["reply-0", 1],
      ["reply-1", 2],
      ["reply-2", MAX_NOTE_THREAD_DEPTH],
      ["reply-3", MAX_NOTE_THREAD_DEPTH],
      ["reply-4", MAX_NOTE_THREAD_DEPTH],
    ]);
  });

  test("titles notes as the terminal does and marks stale ones", () => {
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
    expect(cards.map((card) => [card.title, card.rangeLabel, card.stale])).toEqual([
      ["sonnet", "R12", false],
      ["Agent note", "R41", true],
      ["Your note · 5m", "R42", false],
    ]);
  });

  test("hides agent notes, not the reviewer's own, when agent notes are off", () => {
    const state = {
      liveNotes: stored(createTestNote("agent", 12)),
      userNotes: stored(createTestNote("mine", 42, { source: "user" })),
      showAgentNotes: false,
    };
    const sidecar: ReviewSharedNoteV1[] = [
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
