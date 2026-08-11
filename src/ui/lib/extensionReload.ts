import type { ExtensionLoadResult } from "../../extensions/types";

/** Retire one extension registry so none of its delayed callbacks can publish. */
function retireExtensionResult(result: ExtensionLoadResult | undefined) {
  if (!result) return;
  result.registry.emitCustomEvent = undefined;
  result.registry.eventBusPhase = "closed";
  result.registry.pendingCustomEvents.length = 0;
}

/**
 * Load a replacement without closing the active registry until publication is safe.
 *
 * A stale replacement is retired instead, leaving the still-active registry
 * untouched for whichever newer reload won the generation check.
 */
export async function stageExtensionReload({
  active,
  assertCurrent,
  load,
  publish,
}: {
  active: ExtensionLoadResult | undefined;
  assertCurrent: () => void;
  load: () => Promise<ExtensionLoadResult>;
  /** Synchronously replace the host reference in the validated continuation. */
  publish: (replacement: ExtensionLoadResult) => void;
}) {
  const replacement = await load();
  try {
    assertCurrent();
  } catch (error) {
    retireExtensionResult(replacement);
    throw error;
  }

  // Publish and retire in one synchronous continuation. Returning the result
  // for caller-side assignment would open a microtask gap with a closed active
  // registry still stored in the host reference.
  publish(replacement);
  retireExtensionResult(active);
  return replacement;
}
