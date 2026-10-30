/**
 * The golden corpus every review consumer is checked against.
 *
 * Each fixture is a real parse of real content — the parser's own hunk geometry is part
 * of what the corpus pins — and every expectation below is written by hand from the
 * unified-diff semantics. The adversarial cases come straight from the audit's findings:
 * they are the inputs the deleted copies got wrong.
 */
import { createTestDiffFile, lines } from "../helpers/diff-helpers";
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";
import type { ReviewGeometryFixture } from "./types";

/** Twelve numbered lines, the base every geometry fixture edits. */
const BASE_LINES = Array.from({ length: 12 }, (_unused, index) => `line ${index + 1}`);

/** Build the base file's text with one edit applied to the numbered lines. */
function edited(edit: (values: string[]) => string[]) {
  return lines(...edit([...BASE_LINES]));
}

/** Parse one before/after pair the way the app's loaders do. */
function parsed(input: {
  id: string;
  before: string;
  after: string;
  context?: number;
  path?: string;
}): DiffFile[] {
  return [
    createTestDiffFile({
      before: input.before,
      after: input.after,
      context: input.context ?? 0,
      id: input.id,
      path: input.path ?? `${input.id}.ts`,
    }),
  ];
}

const PURE_INSERTION_AFTER = edited((values) => [
  ...values.slice(0, 6),
  "inserted",
  ...values.slice(6),
]);
const PURE_DELETION_AFTER = edited((values) => values.filter((line) => line !== "line 6"));
const CHANGED_SIXTH_AFTER = edited((values) =>
  values.map((l) => (l === "line 6" ? "line six" : l)),
);

export const REVIEW_GEOMETRY_FIXTURES: readonly ReviewGeometryFixture[] = [
  {
    id: "pure-insertion-hunk",
    findings: ["A1", "A2", "A10"],
    description:
      "@@ -6,0 +7,1 @@ — the old side has no rows, so its leading gap ends at the line the hunk is positioned at, not one before it.",
    build: () =>
      parsed({ id: "insertion", before: lines(...BASE_LINES), after: PURE_INSERTION_AFTER }),
    expansion: { fileIndex: 0, gapId: "before:0", sourceText: PURE_INSERTION_AFTER },
    expected: {
      files: [
        {
          path: "insertion.ts",
          // Old lines 1-6 and new lines 1-6 all precede the insertion point.
          gaps: [{ gapId: "before:0", oldRange: [1, 6], newRange: [1, 6], lineCount: 6 }],
          hunkRanges: [{ oldRange: [6, 6], newRange: [7, 7] }],
          defaultNoteTargets: [{ side: "new", line: 7 }],
          // No trailing gap: the zero-count old side leaves the two line arrays with
          // tails of different lengths, and a gap renders as paired rows (audit A2).
          expandedRows: [
            { oldLine: 1, newLine: 1, text: "line 1" },
            { oldLine: 2, newLine: 2, text: "line 2" },
            { oldLine: 3, newLine: 3, text: "line 3" },
            { oldLine: 4, newLine: 4, text: "line 4" },
            { oldLine: 5, newLine: 5, text: "line 5" },
            { oldLine: 6, newLine: 6, text: "line 6" },
          ],
        },
      ],
    },
  },
  {
    id: "pure-deletion-hunk",
    findings: ["A1", "A2"],
    description:
      "@@ -6,1 +5,0 @@ — the new side has no rows, so its leading gap ends at new line 5 and its text must match the old-side labels beside it.",
    build: () =>
      parsed({ id: "deletion", before: lines(...BASE_LINES), after: PURE_DELETION_AFTER }),
    expansion: { fileIndex: 0, gapId: "before:0", sourceText: PURE_DELETION_AFTER },
    expected: {
      files: [
        {
          path: "deletion.ts",
          // Pierre reports the full omitted region even though the new side has no rows.
          gaps: [{ gapId: "before:0", oldRange: [1, 5], newRange: [1, 5], lineCount: 5 }],
          hunkRanges: [{ oldRange: [6, 6], newRange: [5, 5] }],
          defaultNoteTargets: [{ side: "old", line: 6 }],
          expandedRows: [
            { oldLine: 1, newLine: 1, text: "line 1" },
            { oldLine: 2, newLine: 2, text: "line 2" },
            { oldLine: 3, newLine: 3, text: "line 3" },
            { oldLine: 4, newLine: 4, text: "line 4" },
            { oldLine: 5, newLine: 5, text: "line 5" },
          ],
        },
      ],
    },
  },
  {
    id: "hunk-with-leading-context",
    findings: ["A3", "A10"],
    description:
      "@@ -3,7 +3,7 @@ — the hunk's extent covers its context rows, and a whole-hunk note skips past them to the changed line.",
    build: () =>
      parsed({
        id: "context",
        before: lines(...BASE_LINES),
        after: CHANGED_SIXTH_AFTER,
        context: 3,
      }),
    expected: {
      files: [
        {
          path: "context.ts",
          gaps: [
            { gapId: "before:0", oldRange: [1, 2], newRange: [1, 2], lineCount: 2 },
            { gapId: "trailing:0", oldRange: [10, 12], newRange: [10, 12], lineCount: 3 },
          ],
          // Seven rows from line 3: three context, one change, three context.
          hunkRanges: [{ oldRange: [3, 9], newRange: [3, 9] }],
          defaultNoteTargets: [{ side: "new", line: 6 }],
        },
      ],
    },
  },
  {
    id: "crlf-source",
    findings: ["A4"],
    description:
      "A Windows-authored file: expanded rows must carry no carriage return, and line N must still be the Nth line.",
    build: () =>
      parsed({
        id: "crlf",
        before: lines(...BASE_LINES).replaceAll("\n", "\r\n"),
        after: CHANGED_SIXTH_AFTER.replaceAll("\n", "\r\n"),
      }),
    expansion: {
      fileIndex: 0,
      gapId: "trailing:0",
      sourceText: CHANGED_SIXTH_AFTER.replaceAll("\n", "\r\n"),
    },
    expected: {
      files: [
        {
          path: "crlf.ts",
          gaps: [
            { gapId: "before:0", oldRange: [1, 5], newRange: [1, 5], lineCount: 5 },
            { gapId: "trailing:0", oldRange: [7, 12], newRange: [7, 12], lineCount: 6 },
          ],
          hunkRanges: [{ oldRange: [6, 6], newRange: [6, 6] }],
          defaultNoteTargets: [{ side: "new", line: 6 }],
          expandedRows: [
            { oldLine: 7, newLine: 7, text: "line 7" },
            { oldLine: 8, newLine: 8, text: "line 8" },
            { oldLine: 9, newLine: 9, text: "line 9" },
            { oldLine: 10, newLine: 10, text: "line 10" },
            { oldLine: 11, newLine: 11, text: "line 11" },
            { oldLine: 12, newLine: 12, text: "line 12" },
          ],
        },
      ],
    },
  },
  {
    id: "source-without-trailing-newline",
    findings: ["A4"],
    description:
      "A file whose last line has no terminator: the trailing gap must still reach line 12, with no phantom line after it.",
    build: () =>
      parsed({
        id: "unterminated",
        before: BASE_LINES.join("\n"),
        after: CHANGED_SIXTH_AFTER.trimEnd(),
      }),
    expansion: { fileIndex: 0, gapId: "trailing:0", sourceText: CHANGED_SIXTH_AFTER.trimEnd() },
    expected: {
      files: [
        {
          path: "unterminated.ts",
          gaps: [
            { gapId: "before:0", oldRange: [1, 5], newRange: [1, 5], lineCount: 5 },
            { gapId: "trailing:0", oldRange: [7, 12], newRange: [7, 12], lineCount: 6 },
          ],
          hunkRanges: [{ oldRange: [6, 6], newRange: [6, 6] }],
          defaultNoteTargets: [{ side: "new", line: 6 }],
          expandedRows: [
            { oldLine: 7, newLine: 7, text: "line 7" },
            { oldLine: 8, newLine: 8, text: "line 8" },
            { oldLine: 9, newLine: 9, text: "line 9" },
            { oldLine: 10, newLine: 10, text: "line 10" },
            { oldLine: 11, newLine: 11, text: "line 11" },
            { oldLine: 12, newLine: 12, text: "line 12" },
          ],
        },
      ],
    },
  },
  {
    id: "binary-rename-with-no-rows",
    findings: ["A8"],
    description:
      "A renamed binary file: what the change is outranks how it is stored, so every surface calls it a rename.",
    build: () => {
      const [file] = parsed({
        id: "asset",
        before: lines(...BASE_LINES),
        after: lines(...BASE_LINES),
        path: "asset.png",
      });
      return [
        {
          ...file!,
          isBinary: true,
          previousPath: "old-asset.png",
          metadata: { ...file!.metadata, type: "rename-pure", hunks: [] },
        },
      ];
    },
    expected: {
      files: [
        {
          path: "asset.png",
          gaps: [],
          hunkRanges: [],
          defaultNoteTargets: [],
          emptyDiffReason: "rename-only",
        },
      ],
    },
  },
];
