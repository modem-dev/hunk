import { describe, expect, test } from "bun:test";
import type {
  ReviewNoteListEntry,
  ReviewNoteListFile,
  ReviewNoteListThread,
} from "../../core/review/noteList";
import type { ReviewNote } from "../../core/review/types";
import { formatReviewNotesMarkdown } from "./notesMarkdown";

/** One list entry for a test note. */
function testEntry(
  note: Partial<ReviewNote> & Pick<ReviewNote, "id" | "summary">,
  origin: ReviewNoteListEntry["origin"],
  stale = false,
): ReviewNoteListEntry {
  return {
    note: {
      source: origin === "agent" ? "agent" : "user",
      ...(origin === "browser" ? { originalSource: "browser" } : {}),
      fileKey: "file",
      anchor: { newRange: [13, 13], intersectingHunkIndices: [0], ownerHunkIndex: 0 },
      editable: origin !== "agent",
      ...note,
    },
    origin,
    stale,
    stored: true,
  };
}

/** One thread from a root and its replies. */
function testThread(
  root: ReviewNoteListEntry,
  replies: ReviewNoteListEntry[] = [],
): ReviewNoteListThread {
  return { root, replies, fileKey: root.note.fileKey, hunkIndex: 0, line: 13 };
}

describe("formatReviewNotesMarkdown", () => {
  test("groups notes by file in order with authors, locations, bodies, and replies", () => {
    const files: ReviewNoteListFile[] = [
      {
        fileKey: "main",
        path: "src/app/main.ts",
        threads: [
          testThread(
            testEntry(
              {
                id: "a",
                author: "sonnet",
                summary: "Threshold raised.",
                rationale: "Batches under 10 rows\nwere flushing on every tick.",
              },
              "agent",
            ),
            [testEntry({ id: "r", author: "user", summary: "Why 10 and not 8?" }, "reviewer")],
          ),
        ],
      },
      {
        fileKey: "old",
        path: "old/legacy_file.txt",
        threads: [
          testThread(
            testEntry(
              {
                id: "b",
                summary: "Still referenced from the docs.",
                anchor: { oldRange: [2, 4], intersectingHunkIndices: [0] },
              },
              "agent",
              true,
            ),
          ),
        ],
      },
    ];

    expect(formatReviewNotesMarkdown(files)).toBe(
      [
        "# Review notes",
        "",
        "## `src/app/main.ts`",
        "",
        "- **sonnet** (agent) · line 13",
        "  Threshold raised.",
        "",
        "  Batches under 10 rows",
        "  were flushing on every tick.",
        "  - **Reviewer** · line 13",
        "    Why 10 and not 8?",
        "",
        "## `old/legacy_file.txt`",
        "",
        "- **Agent** · old lines 2–4 · stale",
        "  Still referenced from the docs.",
        "",
      ].join("\n"),
    );
  });

  test("names a browser note's author as its card does", () => {
    const files: ReviewNoteListFile[] = [
      {
        fileKey: "main",
        path: "a.ts",
        threads: [testThread(testEntry({ id: "b", summary: "Typo" }, "browser"))],
      },
    ];
    expect(formatReviewNotesMarkdown(files)).toContain("- **Reviewer** (browser) · line 13");
  });

  test("says agent notes were left out when they are hidden", () => {
    const files: ReviewNoteListFile[] = [
      {
        fileKey: "main",
        path: "a.ts",
        threads: [testThread(testEntry({ id: "r", summary: "Mine" }, "reviewer"))],
      },
    ];
    expect(formatReviewNotesMarkdown(files, { agentNotesHidden: true })).toContain(
      "_Agent notes are hidden in this review and are left out._",
    );
    expect(formatReviewNotesMarkdown(files)).not.toContain("hidden");
  });

  test("is empty without notes", () => {
    expect(formatReviewNotesMarkdown([])).toBe("");
  });
});
