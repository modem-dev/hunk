import { describe, expect, test } from "bun:test";
import { createHighlightRetryBudget } from "./highlightRetryBudget";

describe("highlight retry budget", () => {
  test("permits one retry before releasing exhausted history", () => {
    const budget = createHighlightRetryBudget(1, 3);
    expect(budget.recordFailure("file")).toBe(true);
    expect(budget.recordFailure("file")).toBe(false);
    // Suppression now belongs to the cached plain fallback, not retained retry history.
    expect(budget.recordFailure("file")).toBe(true);
  });

  test("reclaims abandoned first-failure keys without requiring another request", () => {
    const budget = createHighlightRetryBudget(1, 3);
    for (let index = 0; index < 1_000; index += 1) {
      expect(budget.recordFailure(`revision-${index}`)).toBe(true);
    }

    // Only the three most recent revision keys retain their first failure.
    expect(budget.recordFailure("revision-997")).toBe(false);
    expect(budget.recordFailure("revision-998")).toBe(false);
    expect(budget.recordFailure("revision-999")).toBe(false);
    expect(budget.recordFailure("revision-996")).toBe(true);
    expect(budget.recordFailure("revision-0")).toBe(true);
  });

  test("protects recently requested provisional keys ahead of abandoned revisions", () => {
    const budget = createHighlightRetryBudget(1, 2);
    budget.recordFailure("visible");
    budget.recordFailure("abandoned");
    budget.touch("visible");
    budget.touch("unknown");
    budget.recordFailure("new-revision");

    expect(budget.recordFailure("visible")).toBe(false);
    expect(budget.recordFailure("new-revision")).toBe(false);
    expect(budget.recordFailure("abandoned")).toBe(true);
  });

  test("clears history after a successful result without evicting its neighbor", () => {
    const budget = createHighlightRetryBudget(1, 2);
    budget.recordFailure("neighbor");
    budget.recordFailure("successful");
    budget.clear("successful");
    budget.clear("unknown");
    budget.recordFailure("new-revision");

    expect(budget.recordFailure("neighbor")).toBe(false);
    expect(budget.recordFailure("successful")).toBe(true);
  });
});
