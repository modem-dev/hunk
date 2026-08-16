import type { ExtensionRegistry } from "../../extensions/types";

/** Host-owned lifetime check shared by controls retained from extension handlers. */
export interface ExtensionCapabilityLease {
  /** Whether the App, extension runtime, and optional review generation still own the control. */
  isLive(): boolean;
}

/**
 * Mint one lease for host-mediated extension capabilities.
 *
 * Runtime identity prevents a retired handler from controlling its replacement;
 * the optional review predicate additionally retires controls when a soft reload
 * changes the review beneath an in-flight handler.
 */
export function createExtensionCapabilityLease({
  getActiveRegistry,
  isAppAlive,
  isReviewCurrent,
  owningRegistry,
}: {
  owningRegistry: ExtensionRegistry | undefined;
  getActiveRegistry: () => ExtensionRegistry | undefined;
  isAppAlive: () => boolean;
  isReviewCurrent?: () => boolean;
}): ExtensionCapabilityLease {
  return Object.freeze({
    isLive: () =>
      isAppAlive() &&
      owningRegistry !== undefined &&
      owningRegistry.eventBusPhase !== "closed" &&
      getActiveRegistry() === owningRegistry &&
      (isReviewCurrent?.() ?? true),
  });
}
