import { describe, expect, test } from "bun:test";
import { getTutorDocumentText } from "../../../../tutor/content";
import { getTutorSpotlightPlan } from ".";

describe("tutor spotlight plan", () => {
  test("addresses every guided step to the exact source phrase it teaches", () => {
    const plan = getTutorSpotlightPlan();

    expect(plan).toHaveLength(36);
    expect(new Set(plan.map((target) => target.taskId)).size).toBe(plan.length);
    for (const target of plan) {
      const sourceLine = getTutorDocumentText(target.path, target.side)?.split("\n")[
        target.line - 1
      ];
      expect(sourceLine?.slice(...target.range)).toBe(target.phrase);
    }
  });
});
