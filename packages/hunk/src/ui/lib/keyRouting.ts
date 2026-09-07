import type { KeyEvent } from "@opentui/core";

/**
 * Who owns a keypress, as decided by one handler in the global key chain.
 *
 * OpenTUI delivers every keypress to global listeners *first* and to the
 * focused renderable *last* — the inverse of the browser model. So a global
 * handler that "doesn't handle" a key is not leaving it alone: it is passing
 * the key down the chain, and ultimately to a focused widget that may act on
 * it too (OpenTUI scroll boxes answer arrows and j/k with a
 * fifth-of-a-viewport scroll of their own; text inputs insert characters).
 *
 * Every handler therefore answers two independent questions:
 *
 *  1. Should the chain keep asking other handlers?  ("stop the chain?")
 *  2. Should the focused renderable still receive the key?  ("stop the key?")
 *
 * A boolean can only answer the first, which historically let handlers act on
 * a key while leaving it live for the focused widget — one Escape closing an
 * overlay *and* wiping filter text, menu arrows moving the selection *and*
 * scrolling the stream behind the menu. `KeyOwner` answers both questions:
 *
 * | answer      | ends chain? | widget receives key? | consumed?           |
 * | ----------- | ----------- | -------------------- | ------------------- |
 * | `"notMine"` | no          | (decided later)      | (decided later)     |
 * | `"mine"`    | yes         | **no**               | yes, by dispatch    |
 * | `"focused"` | yes         | **yes**              | no                  |
 *
 * The fourth combination — keep asking other handlers but suppress the widget
 * — is incoherent, which is why the type has exactly three values.
 *
 * Authoring guide:
 *
 * - The everyday decision is two-state. Did this handler act on the key (or
 *   deliberately swallow it as part of a modal surface)? Then `"mine"`.
 *   Otherwise `"notMine"`.
 * - `"focused"` has exactly one trigger: **a focused text input needs this key
 *   as text.** Consuming would cut off the renderable path the input receives
 *   its characters through, so the handler must end the chain — otherwise a
 *   later handler or the command table would act on plain typing — while
 *   leaving the key itself untouched. If you are about to write a comment
 *   like "let the input own this", you want `"focused"`. Unless you are
 *   adding a new text input, you will never return it.
 */
export type KeyOwner = "notMine" | "mine" | "focused";

/** One handler in the global key chain, answering ownership for one keypress. */
export type KeyOwnerHandler = (key: KeyEvent) => KeyOwner;

/**
 * Walk the global handler chain and enforce the consumption policy centrally.
 *
 * Handlers only *answer* the ownership question; this loop is the single
 * place that acts on the answer. Centralizing the `consume` call is the
 * point: a handler can no longer act on a key and forget to consume it,
 * because "acted" and "consumed" are the same return value.
 *
 * Returns `true` when some handler owned the key (`"mine"` or `"focused"`),
 * meaning the caller must not dispatch it further; `false` means nobody
 * claimed it and the caller may offer it to the command table.
 */
export function routeKeyOwnership(
  handlers: readonly KeyOwnerHandler[],
  key: KeyEvent,
  consume: (key: KeyEvent) => void,
): boolean {
  for (const handle of handlers) {
    const owner = handle(key);
    if (owner === "notMine") {
      continue;
    }

    if (owner === "mine") {
      consume(key);
    }

    return true;
  }

  return false;
}
