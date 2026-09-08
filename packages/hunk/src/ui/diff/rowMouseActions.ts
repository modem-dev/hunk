/** Tracks mouse events claimed by controls nested inside selectable diff rows. */
import type { MouseEvent as TuiMouseEvent } from "@opentui/core";

const nestedRowMouseActions = new WeakSet<TuiMouseEvent>();

/** Mark an event so the parent completes mouse cleanup without selecting the containing line. */
export function markNestedRowMouseAction(event: TuiMouseEvent) {
  nestedRowMouseActions.add(event);
}

/** Return whether a nested control, rather than the diff line, owns this mouse event. */
export function isNestedRowMouseAction(event: TuiMouseEvent) {
  return nestedRowMouseActions.has(event);
}
