import { describe, expect, test } from "bun:test";
import { createEmptyExtensionRegistry } from "../../extensions/types";
import {
  createExtensionCapabilityLease,
  runWithExtensionCapabilityLease,
} from "./extensionCapabilityLease";

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

describe("runWithExtensionCapabilityLease", () => {
  test("returns the expired answer when authority changes during an async operation", async () => {
    let live = true;
    let finish!: (value: string) => void;
    const operation = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const result = runWithExtensionCapabilityLease(
      { isLive: () => live },
      () => operation,
      () => "expired",
    );

    live = false;
    finish("stale result");

    expect(await result).toBe("expired");
  });

  test("does not start an async operation after authority expires", async () => {
    let started = false;
    const result = await runWithExtensionCapabilityLease(
      { isLive: () => false },
      async () => {
        started = true;
        return "stale result";
      },
      () => "expired",
    );

    expect(started).toBe(false);
    expect(result).toBe("expired");
  });
});
