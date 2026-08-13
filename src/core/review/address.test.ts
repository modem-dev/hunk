import { describe, expect, test } from "bun:test";
import { formatReviewAddress, parseReviewAddress, type ReviewAddress } from "./address";

/** Identifiers that have broken naive string formats: separators, percents, unicode. */
const AWKWARD_IDENTIFIERS = [
  "sha256:abc123",
  "user:1717171717-4",
  "src/nested/path.ts#2",
  "key with spaces",
  "100% coverage",
  "ünïcøde-ключ",
  "a/b/c/d",
  "?query=1&other=2",
];

describe("review address grammar", () => {
  // Intent: the canonical form is stable, so a link a client wrote stays readable.
  test("serializes each address kind to its documented form", () => {
    expect(formatReviewAddress({ kind: "file", fileKey: "abc" })).toBe("file/abc");
    expect(formatReviewAddress({ kind: "hunk", fileKey: "abc", hunkIndex: 2 })).toBe(
      "file/abc/hunk/2",
    );
    expect(formatReviewAddress({ kind: "line", fileKey: "abc", side: "old", line: 41 })).toBe(
      "file/abc/line/old/41",
    );
    expect(formatReviewAddress({ kind: "note", fileKey: "abc", noteId: "user:1" })).toBe(
      "file/abc/note/user%3A1",
    );
  });

  // Intent: identifiers are opaque, so no key or note id can break out of the grammar.
  test("round-trips every address kind through awkward identifiers", () => {
    for (const identifier of AWKWARD_IDENTIFIERS) {
      const addresses: ReviewAddress[] = [
        { kind: "file", fileKey: identifier },
        { kind: "hunk", fileKey: identifier, hunkIndex: 0 },
        { kind: "hunk", fileKey: identifier, hunkIndex: 17 },
        { kind: "line", fileKey: identifier, side: "old", line: 1 },
        { kind: "line", fileKey: identifier, side: "new", line: 9001 },
        { kind: "note", fileKey: identifier, noteId: identifier },
      ];

      for (const address of addresses) {
        expect(parseReviewAddress(formatReviewAddress(address))).toEqual(address);
      }
    }
  });

  // Intent: canonical serialization must never produce text the strict parser rejects.
  test("refuses values the address grammar cannot represent", () => {
    const invalid: ReviewAddress[] = [
      { kind: "file", fileKey: "" },
      { kind: "hunk", fileKey: "abc", hunkIndex: -1 },
      { kind: "hunk", fileKey: "abc", hunkIndex: 1.5 },
      { kind: "hunk", fileKey: "abc", hunkIndex: Number.POSITIVE_INFINITY },
      { kind: "line", fileKey: "abc", side: "new", line: 0 },
      { kind: "line", fileKey: "abc", side: "new", line: -1 },
      { kind: "line", fileKey: "abc", side: "new", line: 1.5 },
      { kind: "line", fileKey: "abc", side: "left" as never, line: 1 },
      { kind: "note", fileKey: "abc", noteId: "" },
    ];

    for (const address of invalid) {
      expect(() => formatReviewAddress(address)).toThrow();
    }
    expect(() => formatReviewAddress({ kind: "file", fileKey: "\ud800" })).toThrow(
      "must be valid Unicode",
    );
  });

  // Intent: an address is untrusted input; a half-understood one must not navigate.
  test("rejects anything that is not exactly the grammar", () => {
    const rejected = [
      "",
      "abc",
      "file",
      "file/",
      "files/abc",
      "file/abc/",
      "file/abc/hunk",
      "file/abc/hunk/",
      "file/abc/hunk/-1",
      "file/abc/hunk/1.5",
      "file/abc/hunk/1/2",
      "file/abc/line/new",
      "file/abc/line/left/3",
      "file/abc/line/new/0",
      "file/abc/line/new/x",
      "file/abc/note",
      "file/abc/note/",
      "file/abc/row/4",
      "file/%zz/hunk/0",
    ];

    for (const text of rejected) {
      expect(parseReviewAddress(text)).toBeUndefined();
    }
  });
});
