import { describe, expect, test } from "bun:test";
import { createReviewCapability } from "../app/review/capability";
import {
  HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY,
  isReviewCapabilityToken,
  parseReviewCapabilityFragment,
  parseReviewHttpPath,
  REVIEW_CAPABILITY_TOKEN_LENGTH,
  reviewHttpPath,
  reviewUrl,
  type HunkReviewHttpRoute,
} from "./reviewHttpProtocol";

const ROUTES: HunkReviewHttpRoute[] = [
  { kind: "publication", sessionId: "session-1" },
  { kind: "events", sessionId: "session-1" },
  { kind: "actions", sessionId: "session-1" },
  {
    kind: "resource",
    sessionId: "session-1",
    generation: "generation:producer:2",
    resourceId: "resource:patch:file:abcdef01",
  },
];

describe("review http routes", () => {
  test("round-trip every route it can build", () => {
    for (const route of ROUTES) {
      expect(parseReviewHttpPath(reviewHttpPath(route))).toEqual(route);
    }
  });

  // Identifiers that would otherwise change the shape of a path must survive it intact —
  // except a path separator, which is refused rather than round-tripped (below).
  test("round-trip identifiers carrying reserved and non-ASCII characters", () => {
    const route: HunkReviewHttpRoute = { kind: "events", sessionId: "セッション 1 #a?b%c" };

    const path = reviewHttpPath(route);

    expect(path).not.toContain("セッション");
    expect(parseReviewHttpPath(path)).toEqual(route);
  });

  test("refuse traversal, wrong depth, and unknown leaves", () => {
    expect(parseReviewHttpPath("/review-api/session-1/../../etc")).toBeUndefined();
    expect(parseReviewHttpPath("/review-api/session-1")).toBeUndefined();
    expect(parseReviewHttpPath("/review-api/session-1/snapshot")).toBeUndefined();
    expect(parseReviewHttpPath("/review-api//events")).toBeUndefined();
    expect(parseReviewHttpPath("/review-api/session-1/resources/gen")).toBeUndefined();
    expect(parseReviewHttpPath("/session-api/session-1/events")).toBeUndefined();
  });

  test("refuse a percent-encoded path separator rather than decoding into one", () => {
    expect(parseReviewHttpPath("/review-api/a%2Fb/events")).toBeUndefined();
    expect(parseReviewHttpPath("/review-api/%ZZ/events")).toBeUndefined();
  });
});

describe("review capability tokens", () => {
  test("accept exactly what the session mints", () => {
    const { token } = createReviewCapability();

    expect(token).toHaveLength(REVIEW_CAPABILITY_TOKEN_LENGTH);
    expect(isReviewCapabilityToken(token)).toBe(true);
  });

  test("refuse anything of another width or alphabet", () => {
    expect(isReviewCapabilityToken("a".repeat(REVIEW_CAPABILITY_TOKEN_LENGTH - 1))).toBe(false);
    expect(isReviewCapabilityToken("a".repeat(REVIEW_CAPABILITY_TOKEN_LENGTH + 1))).toBe(false);
    expect(isReviewCapabilityToken(`${"a".repeat(REVIEW_CAPABILITY_TOKEN_LENGTH - 1)}+`)).toBe(
      false,
    );
    expect(isReviewCapabilityToken(undefined)).toBe(false);
  });

  test("mint a different capability every time", () => {
    expect(createReviewCapability().token).not.toBe(createReviewCapability().token);
  });
});

describe("review url", () => {
  // The whole point of the fragment: a fragment is not sent to any server, so the
  // capability appears in no request target and no log.
  test("carries the capability in the fragment and nowhere else", () => {
    const { token } = createReviewCapability();

    const url = new URL(reviewUrl("http://127.0.0.1:4300", "session-1", token));

    expect(url.hash).toContain(token);
    expect(url.pathname).not.toContain(token);
    expect(url.search).toBe("");
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(token);
  });

  test("round-trips through the fragment grammar", () => {
    const { token } = createReviewCapability();

    const url = new URL(reviewUrl("http://127.0.0.1:4300", "session-1", token));

    expect(parseReviewCapabilityFragment(url.hash)).toBe(token);
    expect(parseReviewCapabilityFragment(url.hash.slice(1))).toBe(token);
  });

  test("refuses a fragment that is not a capability", () => {
    expect(parseReviewCapabilityFragment("")).toBeUndefined();
    expect(parseReviewCapabilityFragment("#other=value")).toBeUndefined();
    expect(
      parseReviewCapabilityFragment(`#${HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY}=short`),
    ).toBeUndefined();
  });
});
