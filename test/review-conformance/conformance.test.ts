import { describe, expect, test } from "bun:test";
import { ReviewProducer } from "../../packages/hunk/src/app/review/producer";
import {
  classifyReviewPublication,
  type ReviewPublicationAddress,
} from "../../packages/hunk/src/core/review/generationOrder";
import {
  isBlankReviewNoteBody,
  planReviewIntent,
} from "../../packages/hunk/src/core/review/intents";
import { reviewNoteWithinSizeLimit } from "../../packages/hunk/src/core/review/noteSize";
import { createInitialReviewState } from "../../packages/hunk/src/core/review/state";
import { createReviewStore } from "../../packages/hunk/src/core/review/store";
import { createTestDiffFile } from "../helpers/diff-helpers";
import { createTestReviewDocument } from "../helpers/review-store-helpers";
import {
  REVIEW_EVENT_CONSUMERS,
  REVIEW_GEOMETRY_CONSUMERS,
  REVIEW_NAVIGATION_CONSUMERS,
  REVIEW_ORDERING_CONSUMERS,
  REVIEW_SNAPSHOT_CONSUMERS,
  REVIEW_WIRE_CONSUMERS,
} from "./consumers";
import { REVIEW_EVENT_FIXTURES } from "./eventFixtures";
import { REVIEW_GEOMETRY_FIXTURES } from "./geometryFixtures";
import { REVIEW_NAVIGATION_FIXTURES } from "./navigationFixtures";
import { REVIEW_NOTE_BODY_FIXTURES } from "./noteBodies";
import { REVIEW_NOTE_SIZE_FIXTURES } from "./noteSize";
import { REVIEW_SNAPSHOT_FIXTURES } from "./snapshotFixtures";
import {
  REVIEW_PRODUCER_ORDER_FIXTURES,
  REVIEW_PUBLICATION_ORDER_FIXTURES,
} from "./orderingFixtures";
import { REVIEW_WIRE_FIXTURES } from "./wireFixtures";

/** Findings whose adversarial fixture must exist for the finding to count as repaid. */
const REQUIRED_FINDINGS = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A8",
  "A10",
  "B1",
  "B2",
  "B3",
  "B4",
  "B6",
  "B10",
  "B12",
  "C1",
  "C4",
  "D1",
  "EXT1",
];

describe("review conformance corpus", () => {
  test("registers every consumer that has landed so far", () => {
    expect(REVIEW_GEOMETRY_CONSUMERS.map((consumer) => consumer.name)).toEqual([
      "core review model",
      "terminal render planning",
      "review producer",
    ]);
    expect(REVIEW_NAVIGATION_CONSUMERS.map((consumer) => consumer.name)).toEqual([
      "core intent planner",
      "terminal review",
    ]);
    expect(REVIEW_ORDERING_CONSUMERS.map((consumer) => consumer.name)).toEqual([
      "core publication ordering",
      "broker review mirror",
    ]);
    expect(REVIEW_SNAPSHOT_CONSUMERS.map((consumer) => consumer.name)).toEqual([
      "extension review snapshot",
    ]);
    expect(REVIEW_WIRE_CONSUMERS.map((consumer) => consumer.name)).toEqual([
      "review wire protocol",
    ]);
    expect(REVIEW_EVENT_CONSUMERS.map((consumer) => consumer.name)).toEqual([
      "review event protocol",
      "browser review HTTP surface",
    ]);
  });

  test("carries an adversarial fixture for every finding it claims to repay", () => {
    const covered = new Set([
      ...REVIEW_GEOMETRY_FIXTURES.flatMap((fixture) => fixture.findings),
      ...REVIEW_NAVIGATION_FIXTURES.flatMap((fixture) => fixture.findings),
      ...REVIEW_PUBLICATION_ORDER_FIXTURES.flatMap((fixture) => fixture.findings),
      ...REVIEW_PRODUCER_ORDER_FIXTURES.flatMap((fixture) => fixture.findings),
      ...REVIEW_WIRE_FIXTURES.flatMap((fixture) => fixture.findings),
      ...REVIEW_EVENT_FIXTURES.flatMap((fixture) => fixture.findings),
      ...REVIEW_SNAPSHOT_FIXTURES.flatMap((fixture) => fixture.findings),
      ...(REVIEW_NOTE_SIZE_FIXTURES.length > 0 ? ["D1"] : []),
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

for (const consumer of REVIEW_GEOMETRY_CONSUMERS) {
  describe(`review conformance: ${consumer.name}`, () => {
    for (const fixture of REVIEW_GEOMETRY_FIXTURES) {
      test(`${fixture.id} (${fixture.findings.join(", ")})`, () => {
        expect(consumer.project(fixture)).toEqual(fixture.expected);
      });
    }
  });
}

for (const consumer of REVIEW_SNAPSHOT_CONSUMERS) {
  describe(`review snapshot conformance: ${consumer.name}`, () => {
    for (const fixture of REVIEW_SNAPSHOT_FIXTURES) {
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

describe("review conformance: note size", () => {
  for (const fixture of REVIEW_NOTE_SIZE_FIXTURES) {
    test(`${fixture.id} ${fixture.withinSizeLimit ? "fits" : "is too large"}`, () => {
      expect(reviewNoteWithinSizeLimit(fixture.build())).toBe(fixture.withinSizeLimit);
    });
  }
});

for (const consumer of REVIEW_ORDERING_CONSUMERS) {
  describe(`review publication ordering: ${consumer.name}`, () => {
    for (const fixture of REVIEW_PUBLICATION_ORDER_FIXTURES) {
      test(`${fixture.id} is ${fixture.expected} (${fixture.findings.join(", ")})`, () => {
        expect(consumer.classify(fixture.current, fixture.incoming)).toBe(fixture.expected);
      });
    }
  });
}

for (const consumer of REVIEW_WIRE_CONSUMERS) {
  describe(`review wire conformance: ${consumer.name}`, () => {
    for (const fixture of REVIEW_WIRE_FIXTURES) {
      test(`${fixture.id} (${fixture.findings.join(", ")})`, () => {
        expect(consumer.parseAction(fixture.action)).toEqual(fixture.expected);
      });
    }

    // D1: the note-size corpus is a wire question too. The case every field passes and the
    // whole note fails must be refused here, before it can be admitted and then poison the
    // snapshot that publishes it.
    for (const fixture of REVIEW_NOTE_SIZE_FIXTURES) {
      test(`${fixture.id} is ${fixture.withinSizeLimit ? "transportable" : "refused"} (D1)`, () => {
        expect(consumer.acceptsNote(fixture.build())).toBe(fixture.withinSizeLimit);
      });
    }
  });
}

for (const consumer of REVIEW_EVENT_CONSUMERS) {
  describe(`review event conformance: ${consumer.name}`, () => {
    for (const fixture of REVIEW_EVENT_FIXTURES) {
      test(`${fixture.id} (${fixture.findings.join(", ")})`, async () => {
        expect(await consumer.frame(fixture)).toEqual(fixture.expected);
      });
    }
  });
}

describe("review conformance: producer ordering", () => {
  for (const fixture of REVIEW_PRODUCER_ORDER_FIXTURES) {
    test(`${fixture.id} (${fixture.findings.join(", ")})`, () => {
      const files = [createTestDiffFile({ before: "alpha\n", after: "beta\n" })];
      const producer = new ReviewProducer(
        { files, sourceLabel: "/repo" },
        {
          producerId: "conformance",
        },
      );
      const store = createReviewStore(producer.getPublication().document);
      producer.attachStore(store);

      let previous: ReviewPublicationAddress = producer.getPublicationAddress();
      const verdicts = fixture.steps.map((step, index) => {
        if (step.kind === "reload") {
          producer.publish({ files, sourceLabel: "/repo" });
          // A generation owns its own store. The real host mounts replacement state after
          // publishing, so the producer consumer must do the same before a later state step.
          producer.attachStore(createReviewStore(producer.getPublication().document));
        } else {
          // Any real state change advances the store's revision; the filter is the
          // cheapest one that does not depend on what the fixture's files contain.
          producer.applyIntent({ type: "filter/set", filter: `step-${index}` });
        }
        const next = producer.getPublicationAddress();
        const verdict = classifyReviewPublication(previous, next);
        previous = next;
        return verdict;
      });

      expect(verdicts).toEqual(fixture.steps.map((step) => step.expected));
    });
  }
});
