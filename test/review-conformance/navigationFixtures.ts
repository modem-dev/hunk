/**
 * The navigation half of the golden corpus.
 *
 * These fixtures pin what the shared walk answers: where a repeated annotated step lands,
 * which scopes wrap and which stop, what a selection means once its file is filtered away
 * or gone, and which line a reveal scrolls to. Every expectation is written by hand from
 * the semantics — the audit's B-findings are exactly the cases the old per-consumer copies
 * disagreed about, so a captured expectation would preserve the disagreement.
 */
import { createTestDiffFile, lines } from "../helpers/diff-helpers";
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";
import type { ReviewNavigationFixture } from "./types";

/** Twelve numbered lines, the base every navigation fixture edits. */
const BASE_LINES = Array.from({ length: 12 }, (_unused, index) => `line ${index + 1}`);

/** Rewrite the given 1-based lines, leaving the rest of the file alone. */
function withEdits(edits: Record<number, string>) {
  return lines(...BASE_LINES.map((line, index) => edits[index + 1] ?? line));
}

/**
 * A file whose two edits are far enough apart to parse as two hunks at zero context:
 * `@@ -2,1 +2,1 @@` and `@@ -10,1 +10,1 @@`.
 */
function twoHunkFile(id: string): DiffFile {
  return createTestDiffFile({
    id,
    path: `${id}.ts`,
    before: lines(...BASE_LINES),
    after: withEdits({ 2: "line two", 10: "line ten" }),
    context: 0,
  });
}

/** The three-file, six-hunk stream most navigation fixtures walk. */
function threeFileStream(): DiffFile[] {
  return [twoHunkFile("alpha"), twoHunkFile("beta"), twoHunkFile("gamma")];
}

/** Both hunks of a `twoHunkFile`, as reveal targets: the changed line on each side. */
const TWO_HUNK_REVEAL_TARGETS = [
  { side: "new", line: 2 },
  { side: "new", line: 10 },
] as const;

const THREE_FILE_REVEAL_TARGETS = [
  [...TWO_HUNK_REVEAL_TARGETS],
  [...TWO_HUNK_REVEAL_TARGETS],
  [...TWO_HUNK_REVEAL_TARGETS],
];

/** The reveal every annotated-hunk landing asks for. */
const NOTE_REVEAL = { anchor: "hunk", scrollToNote: true } as const;
const HUNK_REVEAL = { anchor: "hunk", scrollToNote: false } as const;
const FILE_TOP_REVEAL = { anchor: "file-top", scrollToNote: false } as const;

export const REVIEW_NAVIGATION_FIXTURES: readonly ReviewNavigationFixture[] = [
  {
    id: "annotated-hunk-multi-step-carry",
    findings: ["B1"],
    description:
      "Stepping from an unannotated hunk: the first step reaches the nearest annotated hunk, and the rest of the count is spent from there rather than swallowed by the approach.",
    build: threeFileStream,
    // Annotated cursors, in stream order: alpha:0, beta:1, gamma:0, gamma:1.
    annotatedHunks: { 0: [0], 1: [1], 2: [0, 1] },
    moves: [
      { scope: "annotated-hunk", delta: 1, from: { file: 0, hunkIndex: 1 } },
      { scope: "annotated-hunk", delta: 2, from: { file: 0, hunkIndex: 1 } },
      { scope: "annotated-hunk", delta: 3, from: { file: 0, hunkIndex: 1 } },
      { scope: "annotated-hunk", delta: 9, from: { file: 0, hunkIndex: 1 } },
      { scope: "annotated-hunk", delta: -1, from: { file: 2, hunkIndex: 0 } },
      { scope: "annotated-hunk", delta: -2, from: { file: 2, hunkIndex: 0 } },
      { scope: "annotated-hunk", delta: -9, from: { file: 2, hunkIndex: 0 } },
      // From a position already in the subset, the count applies directly.
      { scope: "annotated-hunk", delta: 2, from: { file: 0, hunkIndex: 0 } },
    ],
    selections: [{ file: 1, hunkIndex: 1 }],
    expected: {
      moves: [
        { to: { file: 1, hunkIndex: 1 }, reveal: NOTE_REVEAL },
        { to: { file: 2, hunkIndex: 0 }, reveal: NOTE_REVEAL },
        { to: { file: 2, hunkIndex: 1 }, reveal: NOTE_REVEAL },
        { to: { file: 2, hunkIndex: 1 }, reveal: NOTE_REVEAL },
        { to: { file: 1, hunkIndex: 1 }, reveal: NOTE_REVEAL },
        { to: { file: 0, hunkIndex: 0 }, reveal: NOTE_REVEAL },
        { to: { file: 0, hunkIndex: 0 }, reveal: NOTE_REVEAL },
        { to: { file: 2, hunkIndex: 0 }, reveal: NOTE_REVEAL },
      ],
      normalizedSelections: [{ file: 1, hunkIndex: 1 }],
      revealTargets: THREE_FILE_REVEAL_TARGETS,
    },
  },
  {
    id: "scope-wrap-and-clamp",
    findings: ["B2", "B3"],
    description:
      "The same edge, four scopes: hunk re-reveals, file declines to move at all, annotated-hunk clamps, annotated-file cycles.",
    build: threeFileStream,
    // Only the outer files carry notes, so the ring has two stops with a gap between them.
    annotatedHunks: { 0: [0], 2: [0] },
    moves: [
      { scope: "hunk", delta: 1, from: { file: 2, hunkIndex: 1 } },
      { scope: "hunk", delta: -1, from: { file: 0, hunkIndex: 0 } },
      { scope: "hunk", delta: 1, from: { file: 0, hunkIndex: 1 } },
      { scope: "hunk", delta: -1, from: { file: 1, hunkIndex: 0 } },
      { scope: "file", delta: 1, from: { file: 2, hunkIndex: 1 } },
      { scope: "file", delta: -1, from: { file: 0, hunkIndex: 0 } },
      { scope: "file", delta: 1, from: { file: 0, hunkIndex: 1 } },
      { scope: "annotated-hunk", delta: 1, from: { file: 2, hunkIndex: 0 } },
      { scope: "annotated-file", delta: 1, from: { file: 2, hunkIndex: 0 } },
      { scope: "annotated-file", delta: -1, from: { file: 0, hunkIndex: 0 } },
      // From a file with no notes, the ring is entered at its start before stepping.
      { scope: "annotated-file", delta: 1, from: { file: 1, hunkIndex: 0 } },
    ],
    selections: [{ file: 2, hunkIndex: 1 }],
    expected: {
      moves: [
        // Clamping re-selects the same hunk and asks to be shown it again.
        { to: { file: 2, hunkIndex: 1 }, reveal: HUNK_REVEAL },
        { to: { file: 0, hunkIndex: 0 }, reveal: HUNK_REVEAL },
        // Crossing forward into another file puts that file's header on screen.
        { to: { file: 1, hunkIndex: 0 }, reveal: FILE_TOP_REVEAL },
        // Crossing backward reveals the hunk itself, near the previous file's end.
        { to: { file: 0, hunkIndex: 1 }, reveal: HUNK_REVEAL },
        // File navigation at an end does nothing at all.
        { to: null },
        { to: null },
        { to: { file: 1, hunkIndex: 0 }, reveal: FILE_TOP_REVEAL },
        { to: { file: 2, hunkIndex: 0 }, reveal: NOTE_REVEAL },
        { to: { file: 0, hunkIndex: 0 }, reveal: HUNK_REVEAL },
        { to: { file: 2, hunkIndex: 0 }, reveal: HUNK_REVEAL },
        { to: { file: 2, hunkIndex: 0 }, reveal: HUNK_REVEAL },
      ],
      normalizedSelections: [{ file: 2, hunkIndex: 1 }],
      revealTargets: THREE_FILE_REVEAL_TARGETS,
    },
  },
  {
    id: "selection-outliving-its-file",
    findings: ["B4"],
    description:
      "A filter hiding the selected file leaves the selection alone; a selection whose file the document lost falls back to the first visible file, never to a hidden one.",
    build: () => [twoHunkFile("alpha"), twoHunkFile("beta")],
    filter: "beta",
    moves: [
      // Navigation walks only what the filter shows, from wherever the selection resolves.
      { scope: "hunk", delta: 1, from: { file: "vanished", hunkIndex: 0 } },
      { scope: "file", delta: 1, from: { file: 0, hunkIndex: 0 } },
    ],
    selections: [
      { file: 0, hunkIndex: 1 },
      { file: "vanished", hunkIndex: 3 },
      { file: null, hunkIndex: 0 },
      { file: 1, hunkIndex: 9 },
    ],
    expected: {
      moves: [
        { to: { file: 1, hunkIndex: 1 }, reveal: HUNK_REVEAL },
        // Alpha is hidden, so it is not a step away from anything.
        { to: null },
      ],
      normalizedSelections: [
        // Hidden, but still where the reviewer was.
        { file: 0, hunkIndex: 1 },
        { file: 1, hunkIndex: 0 },
        { file: 1, hunkIndex: 0 },
        // A stale index clamps onto the file it addresses.
        { file: 1, hunkIndex: 1 },
      ],
      revealTargets: [[...TWO_HUNK_REVEAL_TARGETS], [...TWO_HUNK_REVEAL_TARGETS]],
    },
  },
  {
    id: "selection-with-nothing-visible",
    findings: ["B4"],
    description:
      "A filter matching no file leaves nothing to select: the review renders no file rather than quietly falling back to the first one.",
    build: () => [twoHunkFile("alpha")],
    filter: "matches-no-file",
    moves: [{ scope: "hunk", delta: 1, from: { file: 0, hunkIndex: 0 } }],
    selections: [
      { file: "vanished", hunkIndex: 0 },
      { file: null, hunkIndex: 0 },
    ],
    expected: {
      moves: [{ to: null }],
      normalizedSelections: [
        { file: null, hunkIndex: 0 },
        { file: null, hunkIndex: 0 },
      ],
      revealTargets: [[...TWO_HUNK_REVEAL_TARGETS]],
    },
  },
  {
    id: "pure-deletion-reveal-target",
    findings: ["B6"],
    description:
      "@@ -6,1 +5,0 @@ — the new side has no rows, so the reveal target is the old-side line; a file whose hunk opens with context reveals its first row, not its first change.",
    build: () => [
      createTestDiffFile({
        id: "deletion",
        path: "deletion.ts",
        before: lines(...BASE_LINES),
        after: lines(...BASE_LINES.filter((line) => line !== "line 6")),
        context: 0,
      }),
      createTestDiffFile({
        id: "context",
        path: "context.ts",
        before: lines(...BASE_LINES),
        after: withEdits({ 6: "line six" }),
        context: 3,
      }),
    ],
    moves: [],
    selections: [{ file: 0, hunkIndex: 0 }],
    expected: {
      moves: [],
      normalizedSelections: [{ file: 0, hunkIndex: 0 }],
      revealTargets: [
        // Not `{ side: "new", line: 5 }`: the new side has no rows here at all.
        [{ side: "old", line: 6 }],
        // The hunk spans lines 3-9; its position is its first row, while a note about the
        // whole hunk would hang from the changed line 6.
        [{ side: "new", line: 3 }],
      ],
    },
  },
];
