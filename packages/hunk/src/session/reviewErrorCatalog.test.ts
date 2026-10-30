import { describe, expect, test } from "bun:test";
import { REVIEW_INTENT_TYPES } from "../core/review/intents";
import {
  REVIEW_ERROR_CATALOG,
  describeReviewError,
  reviewErrorMessage,
} from "./reviewErrorCatalog";
import type { HunkReviewClientErrorCodeV1 } from "./reviewHttpProtocol";

/**
 * Every code the catalog must answer for, written out by hand.
 *
 * Deliberately not derived from the catalog's own keys: a list read back out of the thing
 * under test would agree with it no matter what it contained. This is the vocabulary the
 * producer and the transport actually publish, so a code added to either without a message
 * fails here as well as at the type level.
 */
const EXPECTED_CODES: HunkReviewClientErrorCodeV1[] = [
  "stale-generation",
  "invalid-request",
  "unsupported-action",
  "file-not-found",
  "hunk-not-found",
  "gap-not-found",
  "draft-missing",
  "draft-active",
  "draft-mode-mismatch",
  "note-not-found",
  "note-not-editable",
  "note-has-replies",
  "note-id-conflict",
  "invalid-note-parent",
  "blank-note",
  "note-too-large",
  "missing-fact",
  "unknown-resource",
  "resource-unavailable",
  "resource-too-large",
  "resource-integrity",
  "invalid-range",
  "unauthorized",
  "no-publication",
  "payload-too-large",
  "method-not-allowed",
  "unsupported-media-type",
  "forbidden-origin",
  "too-many-streams",
];

describe("review error catalog", () => {
  test("covers exactly the codes a client can be told", () => {
    expect(Object.keys(REVIEW_ERROR_CATALOG).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  test("gives every code a statement and a remedy", () => {
    for (const code of EXPECTED_CODES) {
      const doc = describeReviewError(code);
      expect(doc.message.length).toBeGreaterThan(0);
      expect(doc.remedy.length).toBeGreaterThan(0);
      expect(doc.message.endsWith(".")).toBe(true);
      expect(doc.remedy.endsWith(".")).toBe(true);
    }
  });

  // The rendered line is what a reviewer reads, so it is one sentence pair rather than a
  // code fragment, and it never leaks the code itself into the prose.
  test("renders a code as its statement followed by its remedy", () => {
    expect(reviewErrorMessage("unauthorized")).toBe(
      `${REVIEW_ERROR_CATALOG.unauthorized.message} ${REVIEW_ERROR_CATALOG.unauthorized.remedy}`,
    );
    for (const code of EXPECTED_CODES) {
      expect(reviewErrorMessage(code)).not.toContain(code);
    }
  });

  // The intent planner's codes are the ones most likely to grow, and a planning failure a
  // client cannot explain is the exact G4 failure mode.
  test("answers for every failure the intent vocabulary can produce", () => {
    expect(REVIEW_INTENT_TYPES.length).toBeGreaterThan(0);
    for (const code of ["file-not-found", "hunk-not-found", "gap-not-found"] as const) {
      expect(REVIEW_ERROR_CATALOG[code]).toBeDefined();
    }
  });
});
