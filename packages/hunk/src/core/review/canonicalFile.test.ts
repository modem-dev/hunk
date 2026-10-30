import { describe, expect, test } from "bun:test";
import { createTestReviewFile } from "../../../../../test/helpers/review-store-helpers";
import { buildReviewContentManifestFile } from "./contentManifest";
import {
  assertCanonicalFileMatchesManifest,
  ReviewCanonicalFileMismatchError,
  reviewCanonicalFileMismatches,
} from "./canonicalFile";

const file = createTestReviewFile({ key: "file:alpha", patch: "@@ -1 +1 @@\n-a\n+b\n" });
const manifest = buildReviewContentManifestFile(file);

/** Re-serialize one value with its object keys in reverse order at every level. */
function withReversedKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(withReversedKeys) as unknown as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, withReversedKeys(entry)]),
    ) as unknown as T;
  }
  return value;
}

describe("reviewCanonicalFileMismatches", () => {
  test("accepts the file its manifest entry was built from", () => {
    expect(reviewCanonicalFileMismatches(file, manifest)).toEqual([]);
  });

  // Intent: the browser copy compared two fields by `JSON.stringify`, so a key inserted
  // later spuriously failed a file that had not changed (D4).
  test("is insensitive to key order on both sides", () => {
    expect(reviewCanonicalFileMismatches(withReversedKeys(file), manifest)).toEqual([]);
    expect(reviewCanonicalFileMismatches(file, withReversedKeys(manifest))).toEqual([]);
  });

  test("reports a changed top-level field by name", () => {
    expect(reviewCanonicalFileMismatches({ ...file, path: "other.ts" }, manifest)).toEqual([
      "path",
    ]);
  });

  test("reports content the previous checks never compared at all", () => {
    const mutated = {
      ...file,
      hunks: [{ ...file.hunks[0]!, hunkContent: [] }, ...file.hunks.slice(1)],
    };
    // The default note target reads the same blocks, so emptying them is caught twice —
    // once as content, once as the geometry derived from it.
    expect(reviewCanonicalFileMismatches(mutated, manifest)).toEqual([
      "hunks[0].blocks.length",
      "hunks[0].defaultNoteTarget.line",
    ]);
  });

  test("reports a changed patch", () => {
    expect(reviewCanonicalFileMismatches({ ...file, patch: "" }, manifest)).toEqual(["patch"]);
  });

  test("reports derived geometry a moved hunk changes", () => {
    const shifted = {
      ...file,
      hunks: [{ ...file.hunks[0]!, additionStart: 99 }, ...file.hunks.slice(1)],
    };
    expect(reviewCanonicalFileMismatches(shifted, manifest)).toContain(
      "hunks[0].defaultNoteTarget.line",
    );
  });

  test("reports a missing optional field rather than ignoring it", () => {
    const { sourceIdentity: _dropped, ...withoutSource } = {
      ...file,
      sourceIdentity: "source:abc",
    };
    expect(
      reviewCanonicalFileMismatches(
        withoutSource,
        buildReviewContentManifestFile({ ...file, sourceIdentity: "source:abc" }),
      ),
    ).toEqual(["sourceIdentity"]);
  });
});

describe("assertCanonicalFileMatchesManifest", () => {
  test("passes a matching file and names every mismatch otherwise", () => {
    expect(() => assertCanonicalFileMatchesManifest(file, manifest)).not.toThrow();
    try {
      assertCanonicalFileMatchesManifest({ ...file, path: "x.ts" }, manifest);
      throw new Error("expected a mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewCanonicalFileMismatchError);
      expect((error as ReviewCanonicalFileMismatchError).mismatches).toEqual(["path"]);
    }
  });
});
