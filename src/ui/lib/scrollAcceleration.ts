import { MacOSScrollAccel, type ScrollAcceleration } from "@opentui/core";
import { DEFAULT_WHEEL_SCROLL_LINES, type WheelScrollLines } from "../../core/run/wheelScrollLines";

/**
 * Resolve wheel movement from the user's fixed row count or Hunk's cadence-based acceleration.
 *
 * Auto mode keeps the first tick precise, then ramps up during sustained bursts. A numeric
 * preference returns that exact row count for every event so coarse wheels remain predictable.
 */
export function createReviewMouseWheelScrollAcceleration(
  lines: WheelScrollLines = DEFAULT_WHEEL_SCROLL_LINES,
): ScrollAcceleration {
  if (lines !== DEFAULT_WHEEL_SCROLL_LINES) {
    return {
      tick: () => lines,
      reset: () => {},
    };
  }

  return new MacOSScrollAccel({
    A: 0.4,
    tau: 4,
    maxMultiplier: 3,
  });
}
