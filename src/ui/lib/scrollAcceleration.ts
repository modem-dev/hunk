import { MacOSScrollAccel, type ScrollAcceleration } from "@opentui/core";

/**
 * Keep the first wheel tick precise, then ramp up during sustained bursts.
 *
 * This matches the general pattern used by terminal UIs better than scaling by total diff size:
 * short diffs stay controllable, while long repeated wheel gestures still speed up.
 */
export function createReviewMouseWheelScrollAcceleration(): ScrollAcceleration {
  return new MacOSScrollAccel({
    A: 0.4,
    tau: 4,
    maxMultiplier: 3,
  });
}
