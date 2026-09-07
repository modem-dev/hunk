/**
 * Counts mouse presses across the mounted terminal so mutation gestures require consecutive clicks.
 * App observes bubbling presses; handlers that consume a press record it before stopping propagation.
 * Renderer-scoped weak state keeps separate terminal instances and their gesture lifetimes isolated.
 */
import type { MouseEvent } from "@opentui/core";

const presses = new WeakMap<object, { event: MouseEvent; sequence: number }>();

/** Record a press once even when several ancestors observe the same bubbling event. */
export function recordMousePress(renderer: object, event: MouseEvent) {
  if (event.type !== "down") return;
  const previous = presses.get(renderer);
  if (previous?.event === event) return;
  presses.set(renderer, { event, sequence: (previous?.sequence ?? 0) + 1 });
}

/** Read the latest press identity without subscribing to pointer movement or rendering. */
export function mousePressSequence(renderer: object) {
  return presses.get(renderer)?.sequence ?? 0;
}
