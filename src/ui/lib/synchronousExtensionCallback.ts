/** The three outcomes of invoking an extension callback that must finish synchronously. */
export type SynchronousExtensionCallbackResult<Value> =
  | { readonly kind: "returned"; readonly value: Value }
  | { readonly kind: "thenable" }
  | { readonly kind: "threw"; readonly error: unknown };

/** Report whether an untyped extension returned promise-like work. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Invoke one callback whose return value decides the current key or lifecycle transition.
 *
 * A returned thenable is rejected by the contract, but its rejection is still observed so broken
 * third-party code cannot create an unhandled rejection after the host has safely moved on.
 */
export function callExtensionSynchronously<Value>(
  callback: () => Value,
): SynchronousExtensionCallbackResult<Value> {
  try {
    const value = callback();
    if (!isThenable(value)) return { kind: "returned", value };
    void Promise.resolve(value).catch(() => {});
    return { kind: "thenable" };
  } catch (error) {
    return { kind: "threw", error };
  }
}
