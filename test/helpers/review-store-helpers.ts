/**
 * Builds renderer-neutral review state for the review store's unit tests.
 *
 * Builders stay minimal on purpose: a test states only the facts it cares about, so a
 * later phase widening the document shape does not rewrite every expectation.
 */
import {
  createInitialReviewState,
  reviewLineAnchor,
  type ReviewState,
  type ReviewStoredNote,
} from "../../src/core/review/state";
import type { ReviewDocumentV1, ReviewFileV1 } from "../../src/core/review/types";

export interface TestReviewFileInput {
  key: string;
  hunkCount?: number;
  path?: string;
  sourceIdentity?: string;
}

/** Build one review file with defaults for everything the test does not name. */
export function createTestReviewFile(input: TestReviewFileInput): ReviewFileV1 {
  return {
    key: input.key,
    runtimeId: input.key,
    path: input.path ?? `${input.key}.ts`,
    hunkCount: input.hunkCount ?? 2,
    ...(input.sourceIdentity !== undefined ? { sourceIdentity: input.sourceIdentity } : {}),
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
  resolution?: ReviewStoredNote["resolution"];
  summary?: string;
}): ReviewStoredNote {
  const hunkIndex = input.hunkIndex ?? 0;
  const line = input.line ?? 1;
  return {
    note: {
      id: input.id,
      source: input.source ?? "agent",
      fileKey: input.fileKey,
      anchor: reviewLineAnchor({ hunkIndex, side: "new", line }),
      summary: input.summary ?? `note ${input.id}`,
      editable: false,
    },
    resolution: input.resolution ?? "active",
  };
}
