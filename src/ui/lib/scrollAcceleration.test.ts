import { describe, expect, test } from "bun:test";
import { createReviewMouseWheelScrollAcceleration } from "./scrollAcceleration";

describe("review mouse wheel acceleration", () => {
  test("keeps the first auto tick precise", () => {
    const acceleration = createReviewMouseWheelScrollAcceleration("auto");

    expect(acceleration.tick(1_000)).toBe(1);
  });

  test("returns an exact configured row count for every wheel event", () => {
    const acceleration = createReviewMouseWheelScrollAcceleration(3);

    expect(acceleration.tick(1_000)).toBe(3);
    expect(acceleration.tick(1_001)).toBe(3);
    acceleration.reset();
    expect(acceleration.tick(2_000)).toBe(3);
  });
});
