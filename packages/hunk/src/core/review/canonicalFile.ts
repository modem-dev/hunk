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
import type { ReviewFileV1 } from "./types";

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
