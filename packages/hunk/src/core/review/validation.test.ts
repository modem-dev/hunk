import { describe, expect, test } from "bun:test";
import {
  hasExactKeys,
  isReviewSha256Digest,
  reviewDigestsEqual,
  utf8ByteLength,
} from "./validation";

const HEX = "a".repeat(64);

describe("utf8ByteLength", () => {
  // Intent: measurement matches what an encoder would actually emit, without one.
  test("counts each code point in the width UTF-8 encodes it at", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("日")).toBe(3);
    expect(utf8ByteLength("🧪")).toBe(4);
    expect(utf8ByteLength("a🧪日é")).toBe(1 + 4 + 3 + 2);
  });

  test("agrees with a platform encoder on mixed text", () => {
    const sample = "hunk — diff 🧪 レビュー\r\n\ttail";
    expect(utf8ByteLength(sample)).toBe(new TextEncoder().encode(sample).byteLength);
  });

  test("counts a lone surrogate as the replacement character it would encode to", () => {
    expect(utf8ByteLength("\ud83e")).toBe(3);
    expect(utf8ByteLength("\udd2a")).toBe(3);
  });
});

describe("hasExactKeys", () => {
  test("rejects missing and extra keys alike", () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
  });

  test("ignores key order", () => {
    expect(hasExactKeys({ b: 2, a: 1 }, ["a", "b"])).toBe(true);
  });
});

describe("review digests", () => {
  // Intent: one canonical spelling, so a writer and a reader cannot disagree on equality.
  test("accepts only canonical lowercase hex of the algorithm's width", () => {
    expect(isReviewSha256Digest(HEX)).toBe(true);
    expect(isReviewSha256Digest(HEX.toUpperCase())).toBe(false);
    expect(isReviewSha256Digest(`${HEX}0`)).toBe(false);
    expect(isReviewSha256Digest(HEX.slice(1))).toBe(false);
    expect(isReviewSha256Digest(undefined)).toBe(false);
  });

  test("compares with both operands normalized", () => {
    expect(reviewDigestsEqual(HEX, HEX.toUpperCase())).toBe(true);
    expect(reviewDigestsEqual(HEX.toUpperCase(), HEX)).toBe(true);
    expect(reviewDigestsEqual(HEX, `b${HEX.slice(1)}`)).toBe(false);
  });
});
