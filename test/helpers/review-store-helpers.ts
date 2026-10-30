/**
 * Builds renderer-neutral review state for the review store's unit tests.
 *
 * Builders stay minimal on purpose: a test states only the facts it cares about, so a
 * later phase widening the document shape does not rewrite every expectation.
 */
import { reviewLineAnchor } from "../../packages/hunk/src/core/review/anchors";
import {
  createInitialReviewState,
  type ReviewState,
  type ReviewStoredNote,
} from "../../packages/hunk/src/core/review/state";
import type {
  ReviewDocumentV1,
  ReviewFileV1,
  ReviewHunkV1,
} from "../../packages/hunk/src/core/review/types";

export interface TestReviewFileInput {
  key: string;
  hunkCount?: number;
  path?: string;
  sourceIdentity?: string;
  sourceAttested?: boolean;
  contentIdentity?: string;
  patch?: string;
}

/**
 * Build one hunk with simple, well-separated geometry.
 *
 * Ten lines apart so a test that anchors a note by line number lands in exactly one hunk
 * without having to state the whole layout.
 */
export function createTestReviewHunk(index: number): ReviewHunkV1 {
  const start = index * 10 + 1;
  return {
    index,
    collapsedBefore: index === 0 ? 0 : 9,
    splitLineStart: index * 3,
    splitLineCount: 3,
    unifiedLineStart: index * 3,
    unifiedLineCount: 3,
    additionStart: start,
    additionCount: 3,
    additionLines: 1,
    additionLineIndex: index * 3,
    deletionStart: start,
    deletionCount: 3,
    deletionLines: 1,
    deletionLineIndex: index * 3,
    hunkContent: [
      { type: "context", lines: 1, additionLineIndex: index * 3, deletionLineIndex: index * 3 },
      {
        type: "change",
        additions: 1,
        deletions: 1,
        additionLineIndex: index * 3 + 1,
        deletionLineIndex: index * 3 + 1,
      },
      {
        type: "context",
        lines: 1,
        additionLineIndex: index * 3 + 2,
        deletionLineIndex: index * 3 + 2,
      },
    ],
    noEOFCRAdditions: false,
    noEOFCRDeletions: false,
  };
}

/** Build one review file with defaults for everything the test does not name. */
export function createTestReviewFile(input: TestReviewFileInput): ReviewFileV1 {
  const hunks = Array.from({ length: input.hunkCount ?? 2 }, (_unused, index) =>
    createTestReviewHunk(index),
  );
  return {
    key: input.key,
    runtimeId: input.key,
    path: input.path ?? `${input.key}.ts`,
    changeKind: "change",
    stats: { additions: hunks.length, deletions: hunks.length, truncated: false },
    flags: { untracked: false, binary: false, tooLarge: false, partial: false },
    patch: input.patch ?? "",
    splitLineCount: hunks.length * 3,
    unifiedLineCount: hunks.length * 3,
    additionLines: hunks.flatMap((hunk) => [`a${hunk.index}`, `b${hunk.index}`, `c${hunk.index}`]),
    deletionLines: hunks.flatMap((hunk) => [`a${hunk.index}`, `B${hunk.index}`, `c${hunk.index}`]),
    hunks,
    contentIdentity: input.contentIdentity ?? `content:${input.key}`,
    ...(input.sourceIdentity !== undefined ? { sourceIdentity: input.sourceIdentity } : {}),
    ...(input.sourceAttested !== undefined ? { sourceAttested: input.sourceAttested } : {}),
  };
}

/** Build one review document from file keys or partial file inputs. */
export function createTestReviewDocument(
  files: ReadonlyArray<string | TestReviewFileInput>,
): ReviewDocumentV1 {
  return {
    files: files.map((file) =>
      createTestReviewFile(typeof file === "string" ? { key: file } : file),
    ),
  };
}

/** Build one initial review state over the given files. */
export function createTestReviewState(
  files: ReadonlyArray<string | TestReviewFileInput> = ["alpha", "beta"],
  options: { showAgentNotes?: boolean } = {},
): ReviewState {
  return createInitialReviewState(createTestReviewDocument(files), options);
}

/** Build one stored mutable note anchored to a single line. */
export function createTestStoredNote(input: {
  id: string;
  fileKey: string;
  hunkIndex?: number;
  line?: number;
  source?: ReviewStoredNote["note"]["source"];
  parentId?: string;
  resolution?: ReviewStoredNote["resolution"];
  summary?: string;
  editable?: boolean;
  createdAt?: string;
}): ReviewStoredNote {
  const hunkIndex = input.hunkIndex ?? 0;
  const line = input.line ?? 1;
  const hunks = Array.from({ length: hunkIndex + 1 }, (_unused, index) =>
    createTestReviewHunk(index),
  );
  return {
    note: {
      id: input.id,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      source: input.source ?? "agent",
      fileKey: input.fileKey,
      anchor: reviewLineAnchor(hunks, { hunkIndex, side: "new", line }),
      summary: input.summary ?? `note ${input.id}`,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      editable: input.editable ?? false,
    },
    resolution: input.resolution ?? "active",
  };
}
