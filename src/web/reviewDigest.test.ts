import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isReviewSha256Digest } from "../core/review/validation";
import { webReviewDigest } from "./reviewDigest";

/** What the session's own edge would compute for the same bytes. */
function nodeDigest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("webReviewDigest", () => {
  test("matches the published vector for the empty input", () => {
    expect(webReviewDigest(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("matches the published vector for 'abc'", () => {
    expect(webReviewDigest(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  // Block boundaries are where a padding bug hides: a message that fills a block exactly
  // needs a whole extra block for its length, and one byte short of that does not.
  test.each([1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1_000, 100_000])(
    "agrees with the session's digest at %i bytes",
    (byteLength) => {
      const bytes = new Uint8Array(byteLength);
      for (let index = 0; index < byteLength; index += 1) {
        bytes[index] = (index * 31 + 7) & 0xff;
      }
      expect(webReviewDigest(bytes)).toBe(nodeDigest(bytes));
    },
  );

  test("agrees with the session's digest on random inputs", () => {
    for (let round = 0; round < 64; round += 1) {
      const bytes = new Uint8Array(Math.floor(Math.random() * 500));
      crypto.getRandomValues(bytes);
      expect(webReviewDigest(bytes)).toBe(nodeDigest(bytes));
    }
  });

  test("produces the canonical form the shared validator accepts", () => {
    expect(isReviewSha256Digest(webReviewDigest(new TextEncoder().encode("hunk")))).toBe(true);
  });
});
