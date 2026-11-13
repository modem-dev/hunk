/**
 * Does this serialized file still describe the review it came from?
 *
 * A producer serves each reviewed file as a canonical JSON resource, and a reader has to
 * be able to check that what it received matches the review it was published with
 * (`docs/browser-review-seam-audit.md`, D4).
 *
 * There is one check here, and it does not carry a field list of its own: it projects the
 * candidate file into a content manifest entry and compares that against the manifest the
 * review published. The manifest is already the model's deterministic description of a
 * file — derived geometry, gap addresses, hunk blocks, patch text — so reusing it means
 * the field list cannot drift from what the model says a file is, and derived facts are
 * checked alongside the content they come from.
 *
 * Comparison is by value at every level, so key order never participates.
 */
import { buildReviewContentManifestFile, type ReviewContentManifestFile } from "./contentManifest";
import { recomputeReviewFileContentIdentity } from "./document";
import type { ReviewFileChangeKind, ReviewFileV1, ReviewHunkBlockV1, ReviewHunkV1 } from "./types";
import { asRecord, hasExactKeys } from "./validation";

/** One field path that disagreed, as a dotted/indexed address into the manifest entry. */
export type ReviewCanonicalFileMismatch = string;

/** Compare two parsed JSON values structurally, collecting the paths that disagree. */
function collectMismatches(path: string, expected: unknown, actual: unknown, into: string[]) {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      into.push(path);
      return;
    }
    if (expected.length !== actual.length) {
      into.push(`${path}.length`);
      return;
    }
    expected.forEach((entry, index) =>
      collectMismatches(`${path}[${index}]`, entry, actual[index], into),
    );
    return;
  }

  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") {
      into.push(path);
      return;
    }
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    // The union of both key sets, so a missing field and an extra one are both reported.
    // Sorted so the report is stable whatever order either side serialized its keys in.
    const keys = [
      ...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]),
    ].sort();
    for (const key of keys) {
      collectMismatches(
        path ? `${path}.${key}` : key,
        expectedRecord[key],
        actualRecord[key],
        into,
      );
    }
    return;
  }

  if (expected !== actual) {
    into.push(path);
  }
}

/**
 * Every way one canonical file disagrees with the manifest entry for it, in field order.
 *
 * An empty result means the file is exactly the one the review published. Callers that
 * only need a verdict read the length; callers reporting a failure get the field paths.
 */
export function reviewCanonicalFileMismatches(
  canonical: ReviewFileV1,
  expected: ReviewContentManifestFile,
): ReviewCanonicalFileMismatch[] {
  const mismatches: string[] = [];
  collectMismatches("", expected, buildReviewContentManifestFile(canonical), mismatches);
  return mismatches;
}

/** Raised when a canonical file and the manifest it claims to describe disagree. */
export class ReviewCanonicalFileMismatchError extends Error {
  override readonly name = "ReviewCanonicalFileMismatchError";

  constructor(readonly mismatches: readonly ReviewCanonicalFileMismatch[]) {
    super(`Canonical review file disagrees with its manifest at: ${mismatches.join(", ")}.`);
  }
}

/**
 * Assert one canonical file against its manifest entry.
 *
 * The producer self-checks with this before serving a canonical file, so a serialization
 * that lost or reordered content fails where it was produced rather than where it is
 * read.
 */
export function assertCanonicalFileMatchesManifest(
  canonical: ReviewFileV1,
  expected: ReviewContentManifestFile,
) {
  const mismatches = reviewCanonicalFileMismatches(canonical, expected);
  if (mismatches.length > 0) {
    throw new ReviewCanonicalFileMismatchError(mismatches);
  }
}

// -- Reading a canonical file from a transport ---------------------------------------------

const CHANGE_KINDS: readonly ReviewFileChangeKind[] = [
  "change",
  "rename-pure",
  "rename-changed",
  "new",
  "deleted",
];

/** Whether one value is a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Whether one value is an array whose every entry passes `check`. */
function isArrayOf<T>(value: unknown, check: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every(check);
}

/** Whether one value is a string. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Whether one record's keys are the required ones plus any of the optional ones. */
function hasKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every((key) => required.includes(key) || optional.includes(key))
  );
}

/** Whether one value is a hunk content block exactly as the projection writes it. */
function isHunkBlock(value: unknown): value is ReviewHunkBlockV1 {
  const record = asRecord(value);
  if (!record || !isCount(record.additionLineIndex) || !isCount(record.deletionLineIndex)) {
    return false;
  }
  if (record.type === "context") {
    return (
      hasExactKeys(record, ["type", "lines", "additionLineIndex", "deletionLineIndex"]) &&
      isCount(record.lines)
    );
  }
  return (
    record.type === "change" &&
    hasExactKeys(record, [
      "type",
      "additions",
      "deletions",
      "additionLineIndex",
      "deletionLineIndex",
    ]) &&
    isCount(record.additions) &&
    isCount(record.deletions)
  );
}

const HUNK_COUNT_FIELDS = [
  "index",
  "collapsedBefore",
  "splitLineStart",
  "splitLineCount",
  "unifiedLineStart",
  "unifiedLineCount",
  "additionStart",
  "additionCount",
  "additionLines",
  "additionLineIndex",
  "deletionStart",
  "deletionCount",
  "deletionLines",
  "deletionLineIndex",
] as const;

/** Whether one value is a hunk record exactly as the projection writes it. */
function isHunk(value: unknown): value is ReviewHunkV1 {
  const record = asRecord(value);
  return (
    record !== undefined &&
    hasKeys(
      record,
      [...HUNK_COUNT_FIELDS, "hunkContent", "noEOFCRAdditions", "noEOFCRDeletions"],
      ["hunkSpecs", "hunkContext"],
    ) &&
    HUNK_COUNT_FIELDS.every((field) => isCount(record[field])) &&
    isArrayOf(record.hunkContent, isHunkBlock) &&
    typeof record.noEOFCRAdditions === "boolean" &&
    typeof record.noEOFCRDeletions === "boolean" &&
    (record.hunkSpecs === undefined || isString(record.hunkSpecs)) &&
    (record.hunkContext === undefined || isString(record.hunkContext))
  );
}

/** Whether one value is a moved-line mark list entry. */
function isMoveKind(value: unknown): value is "moved" | null {
  return value === "moved" || value === null;
}

const FILE_REQUIRED_FIELDS = [
  "key",
  "runtimeId",
  "path",
  "changeKind",
  "stats",
  "flags",
  "patch",
  "splitLineCount",
  "unifiedLineCount",
  "additionLines",
  "deletionLines",
  "hunks",
  "contentIdentity",
] as const;

const FILE_OPTIONAL_FIELDS = [
  "previousPath",
  "language",
  "agentSummary",
  "lineMoveKinds",
  "sourceIdentity",
  "sourceAttested",
] as const;

/** Whether one value has a file's structural shape, before its identity is checked. */
function isReviewFileShape(value: unknown): value is ReviewFileV1 {
  const record = asRecord(value);
  if (!record || !hasKeys(record, FILE_REQUIRED_FIELDS, FILE_OPTIONAL_FIELDS)) {
    return false;
  }

  const stats = asRecord(record.stats);
  const flags = asRecord(record.flags);
  const moves = record.lineMoveKinds === undefined ? undefined : asRecord(record.lineMoveKinds);
  return (
    isString(record.key) &&
    record.key.length > 0 &&
    isString(record.runtimeId) &&
    isString(record.path) &&
    (record.previousPath === undefined || isString(record.previousPath)) &&
    CHANGE_KINDS.includes(record.changeKind as ReviewFileChangeKind) &&
    (record.language === undefined || isString(record.language)) &&
    (record.agentSummary === undefined || isString(record.agentSummary)) &&
    stats !== undefined &&
    hasExactKeys(stats, ["additions", "deletions", "truncated"]) &&
    isCount(stats.additions) &&
    isCount(stats.deletions) &&
    typeof stats.truncated === "boolean" &&
    flags !== undefined &&
    hasExactKeys(flags, ["untracked", "binary", "tooLarge", "partial"]) &&
    Object.values(flags).every((flag) => typeof flag === "boolean") &&
    isString(record.patch) &&
    isCount(record.splitLineCount) &&
    isCount(record.unifiedLineCount) &&
    isArrayOf(record.additionLines, isString) &&
    isArrayOf(record.deletionLines, isString) &&
    (record.lineMoveKinds === undefined ||
      (moves !== undefined &&
        hasExactKeys(moves, ["additionLines", "deletionLines"]) &&
        isArrayOf(moves.additionLines, isMoveKind) &&
        isArrayOf(moves.deletionLines, isMoveKind))) &&
    isArrayOf(record.hunks, isHunk) &&
    record.hunks.every((hunk, index) => hunk.index === index) &&
    isString(record.contentIdentity) &&
    (record.sourceIdentity === undefined || isString(record.sourceIdentity)) &&
    (record.sourceAttested === undefined || typeof record.sourceAttested === "boolean")
  );
}

/** Why one received canonical file was refused. */
export type ReviewCanonicalFileParseFailure =
  /** Not the shape the projection writes: a missing, extra, or wrongly typed field. */
  | "malformed"
  /** Well-formed, but addressed to a different file than the resource it arrived as. */
  | "wrong-file"
  /** Well-formed, but its content no longer hashes to the identity it carries. */
  | "identity-mismatch";

export type ReviewCanonicalFileParseResult =
  | { ok: true; file: ReviewFileV1 }
  | { ok: false; reason: ReviewCanonicalFileParseFailure };

/**
 * Parse one canonical file a reader received, refusing anything it cannot trust.
 *
 * The reader-side half of the D4 check for a consumer that holds no manifest. Three gates,
 * in order: the value has exactly the projection's shape (unknown fields refused, so a
 * field added on one side is not silently dropped on the other); it is the file the
 * resource was addressed to; and its content still hashes to the identity it was published
 * under, which catches content edited or reordered after projection.
 */
export function parseCanonicalReviewFile(
  value: unknown,
  expected: { fileKey: string },
): ReviewCanonicalFileParseResult {
  if (!isReviewFileShape(value)) {
    return { ok: false, reason: "malformed" };
  }
  if (value.key !== expected.fileKey) {
    return { ok: false, reason: "wrong-file" };
  }
  if (recomputeReviewFileContentIdentity(value) !== value.contentIdentity) {
    return { ok: false, reason: "identity-mismatch" };
  }
  return { ok: true, file: value };
}
