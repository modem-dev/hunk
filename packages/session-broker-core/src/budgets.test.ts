import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SESSION_BROKER_LIMITS,
  BrokerCapacityError,
  ReservationGroup,
  mergeSessionBrokerLimits,
  ResourceBudget,
  resolveSessionBrokerLimits,
} from "./budgets";

describe("session broker limits", () => {
  test("publishes immutable contract defaults", () => {
    expect(DEFAULT_SESSION_BROKER_LIMITS).toMatchObject({
      maxSessions: 256,
      maxCommandsPerSession: 64,
      maxCommandsTotal: 1_024,
      maxPreBridgeCommands: 32,
      maxCommandInputBytes: 1024 * 1024,
      maxQueuedCommandBytes: 64 * 1024 * 1024,
      maxRetainedSessionBytes: 4 * 1024 * 1024,
      maxRetainedBytes: 256 * 1024 * 1024,
      defaultCommandTimeoutMs: 15_000,
      maxCommandTimeoutMs: 300_000,
      maxConcurrentHttpControls: 32,
      maxInFlightHttpBodyBytes: 64 * 1024 * 1024,
      maxHttpBodyBytes: 4 * 1024 * 1024,
      maxHttpResponseBytes: 8 * 1024 * 1024,
      maxInFlightHttpResponseBytes: 64 * 1024 * 1024,
      maxWsMessageBytes: 8 * 1024 * 1024,
      maxInFlightWsBytes: 64 * 1024 * 1024,
      challengeTtlMs: 15_000,
      callerSessionTtlMs: 5 * 60_000,
      maxHandshakeDurationMs: 15_000,
    });
    expect(Object.isFrozen(DEFAULT_SESSION_BROKER_LIMITS)).toBe(true);
  });

  test("merges partial daemon lowerings onto a complete broker snapshot", () => {
    const broker = resolveSessionBrokerLimits({
      limits: { maxSessions: 4, maxWsMessageBytes: 64 },
    });
    const merged = mergeSessionBrokerLimits(broker, {
      limits: { maxSessions: 2 },
      unsafeLimits: { maxHttpBodyBytes: broker.maxHttpBodyBytes + 1 },
    });
    expect(merged.maxSessions).toBe(2);
    expect(merged.maxWsMessageBytes).toBe(64);
    expect(merged.maxHttpBodyBytes).toBe(broker.maxHttpBodyBytes + 1);
    expect(() => mergeSessionBrokerLimits(broker, { limits: { maxSessions: 5 } })).toThrow(
      "unsafeLimits",
    );
  });

  test("allows supported lowering and requires unsafeLimits for raising", () => {
    expect(resolveSessionBrokerLimits({ limits: { maxSessions: 1 } }).maxSessions).toBe(1);
    expect(() => resolveSessionBrokerLimits({ limits: { maxSessions: 257 } })).toThrow(
      "unsafeLimits",
    );
    expect(resolveSessionBrokerLimits({ unsafeLimits: { maxSessions: 257 } }).maxSessions).toBe(
      257,
    );
    expect(() => resolveSessionBrokerLimits({ limits: { maxSessions: -1 } })).toThrow(
      "non-negative safe integer",
    );
    expect(() => resolveSessionBrokerLimits({ limits: { unknown: 1 } as never })).toThrow(
      "Unknown session broker limit",
    );
    expect(() =>
      resolveSessionBrokerLimits({
        limits: { maxWsMessageBytes: 8, maxInFlightWsBytes: 7 },
      }),
    ).toThrow("WebSocket message bytes must not exceed in-flight bytes");
    expect(
      resolveSessionBrokerLimits({
        limits: { maxHttpBodyBytes: 4, maxInFlightHttpBodyBytes: 8 },
      }).maxHttpBodyBytes,
    ).toBe(4);
    expect(() =>
      resolveSessionBrokerLimits({
        limits: { maxHttpBodyBytes: 4, maxInFlightHttpBodyBytes: 7 },
      }),
    ).toThrow("source-plus-copy peak");
    expect(
      resolveSessionBrokerLimits({
        limits: { maxHttpResponseBytes: 4, maxInFlightHttpResponseBytes: 8 },
      }).maxHttpResponseBytes,
    ).toBe(4);
    expect(() =>
      resolveSessionBrokerLimits({
        limits: { maxHttpResponseBytes: 4, maxInFlightHttpResponseBytes: 7 },
      }),
    ).toThrow("source-plus-copy peak");
  });
});

describe("resource reservations", () => {
  test("accepts the exact boundary, rejects boundary plus one, and releases idempotently", () => {
    const budget = new ResourceBudget(4, "test");
    const reservation = budget.reserve(4);
    expect(budget.used).toBe(4);
    expect(() => budget.reserve(1)).toThrow(BrokerCapacityError);
    reservation.release();
    reservation.release();
    expect(budget.used).toBe(0);
  });

  test("combines a replacement and retired reservation without transient over-admission", () => {
    const budget = new ResourceBudget(10, "bytes");
    const target = budget.reserve(6);
    const credit = budget.reserve(4);
    const replacement = budget.resizeWithCredit(target, 9, credit);
    expect(budget.used).toBe(9);
    expect(target.released).toBe(true);
    expect(credit.released).toBe(true);
    replacement.release();
    expect(budget.used).toBe(0);
  });

  test("resizes retained records by their delta and transfers release ownership", () => {
    const budget = new ResourceBudget(4, "bytes");
    const original = budget.reserve(4);
    const identical = budget.resize(original, 4);
    expect(budget.used).toBe(4);
    original.release();
    expect(budget.used).toBe(4);
    const smaller = budget.resize(identical, 2);
    expect(budget.used).toBe(2);
    smaller.release();
    expect(budget.used).toBe(0);
  });

  test("reuses capacity after a later grouped reservation fails", () => {
    const count = new ResourceBudget(1, "count");
    const bytes = new ResourceBudget(4, "bytes");
    const group = new ReservationGroup();
    try {
      group.add(count.reserve());
      group.add(bytes.reserve(5));
      throw new Error("expected the byte reservation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BrokerCapacityError);
      group.release();
    }

    const reusedCount = count.reserve();
    const reusedBytes = bytes.reserve(4);
    expect({ count: count.used, bytes: bytes.used }).toEqual({ count: 1, bytes: 4 });
    reusedCount.release();
    reusedBytes.release();
  });

  test("rolls grouped parser/send reservations back exactly once", () => {
    const count = new ResourceBudget(1, "count");
    const bytes = new ResourceBudget(4, "bytes");
    const group = new ReservationGroup();
    group.add(count.reserve());
    group.add(bytes.reserve(4));
    expect(group.amount).toBe(5);
    group.release();
    group.release();
    expect({ count: count.used, bytes: bytes.used }).toEqual({ count: 0, bytes: 0 });
  });
});
