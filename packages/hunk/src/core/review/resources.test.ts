import { describe, expect, test } from "bun:test";
import {
  isMaterializedReviewResource,
  isReviewResourceRange,
  parseReviewResourceId,
  REVIEW_PATCH_CONTENT_TYPE,
  REVIEW_RESOURCE_CHUNK_BYTES,
  reviewResourceId,
} from "./resources";

const fileKey = "file:0123456789abcdef";

describe("review resource ids", () => {
  test("round-trip through the address they were built from", () => {
    for (const address of [
      { kind: "patch", fileKey },
      { kind: "canonical-file", fileKey },
      { kind: "source", fileKey, side: "old" },
      { kind: "source", fileKey, side: "new" },
    ] as const) {
      expect(parseReviewResourceId(reviewResourceId(address))).toEqual(address);
    }
  });

  test("reject ids whose kind and side disagree", () => {
    expect(parseReviewResourceId(`resource:patch:new:${fileKey}`)).toBeUndefined();
    expect(parseReviewResourceId(`resource:source:${fileKey}`)).toBeUndefined();
  });

  test("reject anything outside the grammar", () => {
    for (const value of [
      "resource:unknown:file:abc",
      `resource:patch:${fileKey}:extra`,
      "patch:file:abc",
      42,
    ]) {
      expect(parseReviewResourceId(value)).toBeUndefined();
    }
  });
});

describe("resource materialization state", () => {
  const descriptor = {
    id: reviewResourceId({ kind: "patch", fileKey }),
    kind: "patch",
    generation: "generation:p1:0",
    fileKey,
    contentType: REVIEW_PATCH_CONTENT_TYPE,
  } as const;

  test("is only complete when both measurements are present", () => {
    expect(isMaterializedReviewResource(descriptor)).toBe(false);
    expect(isMaterializedReviewResource({ ...descriptor, byteLength: 10 })).toBe(false);
    expect(isMaterializedReviewResource({ ...descriptor, digest: "a".repeat(64) })).toBe(false);
    expect(
      isMaterializedReviewResource({ ...descriptor, byteLength: 10, digest: "a".repeat(64) }),
    ).toBe(true);
  });
});

describe("isReviewResourceRange", () => {
  test("accepts a window inside the shared chunk bound", () => {
    expect(isReviewResourceRange({ offset: 0, length: 1 })).toBe(true);
    expect(isReviewResourceRange({ offset: 10, length: REVIEW_RESOURCE_CHUNK_BYTES })).toBe(true);
  });

  test("rejects empty, negative, oversized, and non-integer windows", () => {
    expect(isReviewResourceRange({ offset: 0, length: 0 })).toBe(false);
    expect(isReviewResourceRange({ offset: -1, length: 5 })).toBe(false);
    expect(isReviewResourceRange({ offset: 0, length: REVIEW_RESOURCE_CHUNK_BYTES + 1 })).toBe(
      false,
    );
    expect(isReviewResourceRange({ offset: 0.5, length: 5 })).toBe(false);
    expect(isReviewResourceRange(undefined)).toBe(false);
  });
});
