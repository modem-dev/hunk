import { describe, expect, test } from "bun:test";
import { isBlankReviewNoteBody, planReviewIntent } from "../../src/core/review/intents";
import { createInitialReviewState } from "../../src/core/review/state";
import { createTestReviewDocument } from "../helpers/review-store-helpers";
import { REVIEW_CONFORMANCE_CONSUMERS, REVIEW_NAVIGATION_CONSUMERS } from "./consumers";
import { REVIEW_CONFORMANCE_FIXTURES } from "./fixtures";
import { REVIEW_NAVIGATION_FIXTURES } from "./navigationFixtures";
import { REVIEW_NOTE_BODY_FIXTURES } from "./noteBodies";

/** Findings whose adversarial fixture must exist for the finding to count as repaid. */
const REQUIRED_FINDINGS = ["A1", "A2", "A3", "A4", "A8", "A10", "B1", "B2", "B3", "B4", "B6"];

describe("review conformance corpus", () => {
  test("registers every consumer that has landed so far", () => {
    expect(REVIEW_CONFORMANCE_CONSUMERS.map((consumer) => consumer.name)).toEqual([
      "core review model",
      "terminal render planning",
    ]);
    expect(REVIEW_NAVIGATION_CONSUMERS.map((consumer) => consumer.name)).toEqual([
      "core intent planner",
    ]);
  });

  test("carries an adversarial fixture for every finding it claims to repay", () => {
    const covered = new Set([
      ...REVIEW_CONFORMANCE_FIXTURES.flatMap((fixture) => fixture.findings),
      ...REVIEW_NAVIGATION_FIXTURES.flatMap((fixture) => fixture.findings),
    ]);

    expect(REQUIRED_FINDINGS.filter((finding) => !covered.has(finding))).toEqual([]);
  });
});

for (const consumer of REVIEW_NAVIGATION_CONSUMERS) {
  describe(`review navigation conformance: ${consumer.name}`, () => {
    for (const fixture of REVIEW_NAVIGATION_FIXTURES) {
      test(`${fixture.id} (${fixture.findings.join(", ")})`, () => {
        expect(consumer.project(fixture)).toEqual(fixture.expected);
      });
    }
  });
}

for (const consumer of REVIEW_CONFORMANCE_CONSUMERS) {
  describe(`review conformance: ${consumer.name}`, () => {
    for (const fixture of REVIEW_CONFORMANCE_FIXTURES) {
      test(`${fixture.id} (${fixture.findings.join(", ")})`, () => {
        expect(consumer.project(fixture)).toEqual(fixture.expected);
      });
    }
  });
}

describe("review conformance: empty note bodies", () => {
  for (const fixture of REVIEW_NOTE_BODY_FIXTURES) {
    test(`${fixture.id} is ${fixture.blank ? "blank" : "a note"}`, () => {
      expect(isBlankReviewNoteBody(fixture.body)).toBe(fixture.blank);
    });

    test(`${fixture.id} ${fixture.blank ? "retires" : "persists"} the draft it was typed into`, () => {
      const document = createTestReviewDocument(["alpha"]);
      const state = {
        ...createInitialReviewState(document),
        draftNote: {
          id: "draft:1",
          fileKey: document.files[0]!.key,
          hunkIndex: 0,
          side: "new" as const,
          line: 1,
          body: fixture.body,
        },
      };

      const plan = planReviewIntent(
        state,
        { type: "notes/create-user", consumeDraft: true },
        { noteId: "user:1", timestamp: "2024-01-01T00:00:00.000Z" },
      );

      expect(plan.actions.map((action) => action.type)).toEqual([
        fixture.blank ? "draft/cancel" : "draft/save",
      ]);
    });
  }
});
