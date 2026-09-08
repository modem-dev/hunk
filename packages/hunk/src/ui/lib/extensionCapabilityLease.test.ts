import { describe, expect, test } from "bun:test";
import { createEmptyExtensionRegistry } from "../../extensions/types";
import { createExtensionCapabilityLease } from "./extensionCapabilityLease";

describe("createExtensionCapabilityLease", () => {
  test("follows App, runtime, and review-generation ownership", () => {
    const owningRegistry = createEmptyExtensionRegistry();
    owningRegistry.eventBusPhase = "ready";
    let activeRegistry = owningRegistry;
    let appAlive = true;
    let reviewCurrent = true;
    const lease = createExtensionCapabilityLease({
      owningRegistry,
      getActiveRegistry: () => activeRegistry,
      isAppAlive: () => appAlive,
      isReviewCurrent: () => reviewCurrent,
    });

    expect(lease.isLive()).toBe(true);
    reviewCurrent = false;
    expect(lease.isLive()).toBe(false);
    reviewCurrent = true;
    activeRegistry = createEmptyExtensionRegistry();
    expect(lease.isLive()).toBe(false);
    activeRegistry = owningRegistry;
    owningRegistry.eventBusPhase = "closed";
    expect(lease.isLive()).toBe(false);
    owningRegistry.eventBusPhase = "ready";
    appAlive = false;
    expect(lease.isLive()).toBe(false);
  });

  test("can represent runtime authority without binding one review generation", () => {
    const registry = createEmptyExtensionRegistry();
    registry.eventBusPhase = "ready";
    const lease = createExtensionCapabilityLease({
      owningRegistry: registry,
      getActiveRegistry: () => registry,
      isAppAlive: () => true,
    });

    expect(lease.isLive()).toBe(true);
  });
});
