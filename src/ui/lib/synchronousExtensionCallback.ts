/** The three outcomes of invoking an extension callback that must finish synchronously. */
export type SynchronousExtensionCallbackResult<Value> =
  | { readonly kind: "returned"; readonly value: Value }
  | { readonly kind: "thenable" }
  | { readonly kind: "threw"; readonly error: unknown };

/** The routing decisions shared by interactive extension mode flavors. */
type SynchronousExtensionModeKeyResult = "handled" | "pass" | "exit";

/** Read an error without assuming extension code threw an Error instance. */
function describeError(error: unknown) {
  return error instanceof Error ? error.message || error.name : String(error);
}

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

/** Run one extension mode lifecycle callback through the shared synchronous contract. */
export function runSynchronousExtensionModeLifecycle(
  callback: (() => unknown) | undefined,
  phase: "onEnter" | "onExit",
  formatFailure: (action: string, detail: string) => string,
  notify: (message: string) => void,
): boolean {
  if (!callback) return true;

  const result = callExtensionSynchronously(callback);
  if (result.kind === "returned") return true;
  const detail =
    result.kind === "thenable" ? `${phase} must return synchronously` : describeError(result.error);
  notify(formatFailure(phase, detail));
  return false;
}

/** Deliver one extension mode key through the shared synchronous routing contract. */
export function deliverSynchronousExtensionModeKey(
  callback: () => unknown,
  formatFailure: (action: string, detail: string) => string,
  notify: (message: string) => void,
): SynchronousExtensionModeKeyResult {
  const result = callExtensionSynchronously(callback);
  if (result.kind === "returned") {
    return result.value === "handled" || result.value === "exit" ? result.value : "pass";
  }

  const detail =
    result.kind === "thenable" ? "onKey must return synchronously" : describeError(result.error);
  notify(formatFailure("onKey", detail));
  return "exit";
}
