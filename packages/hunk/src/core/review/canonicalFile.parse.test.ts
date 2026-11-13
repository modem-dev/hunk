import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { parseCanonicalReviewFile } from "./canonicalFile";
import { projectReviewDocument, recomputeReviewFileContentIdentity } from "./document";

const [file] = projectReviewDocument([createTestDiffFile({ id: "alpha", path: "src/alpha.ts" })], {
  sourceLabel: "/repo",
}).files;

/** Round-trip a file through JSON, the way a reader receives it. */
function received(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("parseCanonicalReviewFile", () => {
  test("accepts exactly what the projection wrote, after a JSON round trip", () => {
    const result = parseCanonicalReviewFile(received(file), { fileKey: file!.key });

    expect(result).toEqual({ ok: true, file: file! });
  });

  test("recomputes the identity the projection hashed", () => {
    expect(recomputeReviewFileContentIdentity(file!)).toBe(file!.contentIdentity);
  });

  // Intent: an unknown field is refused rather than dropped, so a field added on one side
  // cannot be silently ignored on the other (D4/D5).
  test("refuses an unknown field, a missing field, and a wrongly typed one", () => {
    const { patch: _patch, ...missing } = file!;
    for (const value of [
      { ...file, extra: true },
      missing,
      { ...file, splitLineCount: "4" },
      { ...file, changeKind: "renamed" },
      { ...file, hunks: [{ ...file!.hunks[0], surprise: 1 }] },
      null,
      [],
    ]) {
      expect(parseCanonicalReviewFile(received(value), { fileKey: file!.key })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("refuses a file served as another file's resource", () => {
    expect(parseCanonicalReviewFile(received(file), { fileKey: "file:other" })).toEqual({
      ok: false,
      reason: "wrong-file",
    });
  });

  // Intent: content edited after projection no longer hashes to its identity, which is the
  // check a reader without a manifest can still make.
  test("refuses content that no longer matches its identity", () => {
    const edited = { ...file!, additionLines: [...file!.additionLines, "injected"] };

    expect(parseCanonicalReviewFile(received(edited), { fileKey: file!.key })).toEqual({
      ok: false,
      reason: "identity-mismatch",
    });
  });
});
