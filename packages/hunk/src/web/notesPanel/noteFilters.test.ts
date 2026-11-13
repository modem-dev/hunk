import { describe, expect, test } from "bun:test";
import type { ReviewNoteListEntry, ReviewNoteListFile } from "../../core/review/noteList";
import { countNoteList, filterNoteList } from "./noteFilters";

/** One list entry with a body and an origin. */
function entry(id: string, summary: string, origin: ReviewNoteListEntry["origin"]) {
  return {
    note: {
      id,
      source: origin === "agent" ? "agent" : "user",
      fileKey: "alpha",
      anchor: { intersectingHunkIndices: [0], ownerHunkIndex: 0 },
      summary,
      editable: false,
    },
    origin,
    stale: false,
    stored: true,
  } satisfies ReviewNoteListEntry;
}

const FILES: ReviewNoteListFile[] = [
  {
    fileKey: "alpha",
    path: "alpha.ts",
    threads: [
      {
        root: entry("a", "Rename this helper", "agent"),
        replies: [entry("r", "Agreed, renaming", "reviewer")],
        fileKey: "alpha",
        hunkIndex: 0,
        line: 2,
      },
      {
        root: entry("b", "Typo here", "browser"),
        replies: [],
        fileKey: "alpha",
        hunkIndex: 0,
        line: 3,
      },
    ],
  },
];

const ALL = new Set(["agent", "reviewer", "browser"] as const);

describe("filterNoteList", () => {
  test("keeps a whole thread when any of its notes matches", () => {
    const filtered = filterNoteList(FILES, { origins: new Set(["reviewer"]), text: "" });

    expect(filtered[0]!.threads.map((thread) => thread.root.note.id)).toEqual(["a"]);
    expect(filtered[0]!.threads[0]!.replies).toHaveLength(1);
  });

  test("searches note text case-insensitively and drops files left empty", () => {
    expect(
      filterNoteList(FILES, { origins: ALL, text: " TYPO " })[0]!.threads.map(
        (thread) => thread.root.note.id,
      ),
    ).toEqual(["b"]);
    expect(filterNoteList(FILES, { origins: ALL, text: "nothing" })).toEqual([]);
    expect(filterNoteList(FILES, { origins: new Set(), text: "" })).toEqual([]);
  });

  test("counts notes with their replies", () => {
    expect(countNoteList(FILES)).toBe(3);
  });
});
