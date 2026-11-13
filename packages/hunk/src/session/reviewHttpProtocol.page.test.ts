import { describe, expect, test } from "bun:test";
import {
  HUNK_REVIEW_ASSET_PATH_PREFIX,
  HUNK_REVIEW_HTTP_PATH_PREFIX,
  HUNK_REVIEW_PAGE_PATH_PREFIX,
  isReviewAssetName,
  parseReviewPagePath,
  reviewAssetPath,
  reviewPagePath,
} from "./reviewHttpProtocol";

describe("review page routes", () => {
  test("round-trip the document path for any session id", () => {
    for (const sessionId of ["session-1", "セッション 1 #a?b%c"]) {
      expect(parseReviewPagePath(reviewPagePath(sessionId))).toEqual({
        kind: "document",
        sessionId,
      });
    }
  });

  test("round-trip asset paths", () => {
    expect(parseReviewPagePath(reviewAssetPath("main-abc123.js"))).toEqual({
      kind: "asset",
      name: "main-abc123.js",
    });
  });

  test("keep the three prefixes distinct first segments", () => {
    const prefixes = [
      HUNK_REVIEW_PAGE_PATH_PREFIX,
      HUNK_REVIEW_ASSET_PATH_PREFIX,
      HUNK_REVIEW_HTTP_PATH_PREFIX,
    ];
    expect(new Set(prefixes).size).toBe(3);
    expect(prefixes.every((prefix) => /^\/[a-z-]+$/.test(prefix))).toBe(true);
  });

  test("refuse anything but the exact document and flat asset shapes", () => {
    for (const path of [
      "/review/session-1",
      "/review/session-1/index.html",
      "/review//",
      "/review/a%2Fb/",
      "/review/%ZZ/",
      "/review-assets/",
      "/review-assets/a/b.js",
      "/review-assets/..",
      "/review-assets/%2e%2e",
      "/review-assets/.hidden.js",
      "/review-api/session-1/publication",
      "review/session-1/",
    ]) {
      expect(parseReviewPagePath(path)).toBeUndefined();
    }
  });

  test("name assets only with flat, unencoded segments", () => {
    expect(isReviewAssetName("main-abc123.js")).toBe(true);
    for (const name of ["", "..", "a..b.js", ".a.js", "a/b.js", "a\\b.js", "a%2f.js", "a b.js"]) {
      expect(isReviewAssetName(name)).toBe(false);
    }
    expect(() => reviewAssetPath("../x.js")).toThrow();
  });
});
