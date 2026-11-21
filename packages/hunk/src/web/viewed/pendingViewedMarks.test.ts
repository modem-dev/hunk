import { describe, expect, test } from "bun:test";
import { PendingViewedMarks } from "./pendingViewedMarks";

describe("PendingViewedMarks", () => {
  // Intent: a second toggle before the echo arrives must invert the first, not repeat it.
  test("a second toggle starts from the pending mark", () => {
    const marks = new PendingViewedMarks();
    expect(marks.current("a", false)).toBe(false);
    marks.begin("a", true);
    expect(marks.current("a", false)).toBe(true);
    marks.begin("a", false);
    expect(marks.current("a", false)).toBe(false);
    expect(marks.current("b", true)).toBe(true);
  });

  test("a failed send stops steering, unless a newer mark is pending", () => {
    const marks = new PendingViewedMarks();
    marks.begin("a", true);
    marks.failed("a", true);
    expect(marks.current("a", false)).toBe(false);

    marks.begin("a", true);
    marks.begin("a", false);
    marks.failed("a", true);
    expect(marks.current("a", true)).toBe(false);
  });

  test("an accepted mark ends once the state at its revision is seen", () => {
    const marks = new PendingViewedMarks();
    marks.begin("a", true);
    marks.accepted("a", true, { generation: "g1", stateRevision: 5 });
    marks.observe("g1", 4);
    expect(marks.current("a", false)).toBe(true);
    marks.observe("g1", 5);
    expect(marks.current("a", false)).toBe(false);
  });

  test("an accepted mark ends when the review moved to another generation", () => {
    const marks = new PendingViewedMarks();
    marks.begin("a", true);
    marks.accepted("a", true, { generation: "g1", stateRevision: 5 });
    marks.observe("g2", 1);
    expect(marks.current("a", false)).toBe(false);
  });

  test("a mark still in flight survives unrelated state", () => {
    const marks = new PendingViewedMarks();
    marks.begin("a", true);
    marks.observe("g1", 99);
    expect(marks.current("a", false)).toBe(true);
  });

  test("an older acceptance does not settle a newer pending mark", () => {
    const marks = new PendingViewedMarks();
    marks.begin("a", true);
    marks.begin("a", false);
    marks.accepted("a", true, { generation: "g1", stateRevision: 1 });
    marks.observe("g1", 1);
    expect(marks.current("a", true)).toBe(false);
  });
});
