import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { routeKeyOwnership, type KeyOwner, type KeyOwnerHandler } from "./keyRouting";

/** A bare key event stand-in; ownership routing only threads it through. */
function createTestKey(): KeyEvent {
  return { name: "j" } as KeyEvent;
}

/** Build a handler that records whether it ran and answers with a fixed owner. */
function createTestHandler(owner: KeyOwner) {
  const calls: KeyEvent[] = [];
  const handler: KeyOwnerHandler = (key) => {
    calls.push(key);
    return owner;
  };
  return { calls, handler };
}

describe("routeKeyOwnership", () => {
  test("walks past notMine handlers until one owns the key", () => {
    const first = createTestHandler("notMine");
    const second = createTestHandler("mine");
    const consumed: KeyEvent[] = [];
    const key = createTestKey();

    const owned = routeKeyOwnership([first.handler, second.handler], key, (k) => consumed.push(k));

    expect(owned).toBe(true);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(consumed).toEqual([key]);
  });

  test("mine consumes the key and stops the chain", () => {
    const owner = createTestHandler("mine");
    const unreached = createTestHandler("mine");
    const consumed: KeyEvent[] = [];
    const key = createTestKey();

    const owned = routeKeyOwnership([owner.handler, unreached.handler], key, (k) =>
      consumed.push(k),
    );

    expect(owned).toBe(true);
    expect(consumed).toEqual([key]);
    // Ownership ends the chain: later handlers never see an owned key.
    expect(unreached.calls).toHaveLength(0);
  });

  test("focused stops the chain without consuming, so the key reaches the focused widget", () => {
    const owner = createTestHandler("focused");
    const unreached = createTestHandler("mine");
    const consumed: KeyEvent[] = [];
    const key = createTestKey();

    const owned = routeKeyOwnership([owner.handler, unreached.handler], key, (k) =>
      consumed.push(k),
    );

    expect(owned).toBe(true);
    // Not consumed: preventDefault would cut off the renderable path the
    // focused text input receives its characters through.
    expect(consumed).toHaveLength(0);
    expect(unreached.calls).toHaveLength(0);
  });

  test("returns false and consumes nothing when no handler owns the key", () => {
    const first = createTestHandler("notMine");
    const second = createTestHandler("notMine");
    const consumed: KeyEvent[] = [];

    const owned = routeKeyOwnership([first.handler, second.handler], createTestKey(), (k) =>
      consumed.push(k),
    );

    expect(owned).toBe(false);
    expect(consumed).toHaveLength(0);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  test("an empty chain owns nothing", () => {
    const consumed: KeyEvent[] = [];
    expect(routeKeyOwnership([], createTestKey(), (k) => consumed.push(k))).toBe(false);
    expect(consumed).toHaveLength(0);
  });
});
