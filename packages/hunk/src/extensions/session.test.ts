import { describe, expect, test } from "bun:test";
import { createExtensionNotificationHub } from "./notifications";
import { createExtensionSession } from "./session";
import {
  createEmptyExtensionLoadResult,
  type ExtensionEventHandler,
  type ExtensionLoadResult,
} from "./types";

/** Build a registry with observable startup and shutdown handlers. */
function loadResult(
  id: string,
  events: string[],
  shutdown?: () => void | Promise<void>,
): ExtensionLoadResult {
  const result = createEmptyExtensionLoadResult("/repo", createExtensionNotificationHub());
  result.registry.eventHandlers.startup.push({
    extensionId: id,
    handler: ((payload: { cwd: string }) => {
      events.push(`${id}:start:${payload.cwd}`);
    }) as ExtensionEventHandler,
  });
  result.registry.eventHandlers.shutdown.push({
    extensionId: id,
    handler: async () => {
      events.push(`${id}:stop`);
      await shutdown?.();
    },
  });
  return result;
}

describe("ExtensionSession", () => {
  test("starts each adopted registry once and revokes its predecessor before exposing replacement", async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initial = loadResult("initial", events, () => pending);
    const replacement = loadResult("replacement", events);
    const session = createExtensionSession(initial, "/one");

    expect(session.startCurrent()).toBe(true);
    expect(session.startCurrent()).toBe(false);
    session.trackPrepared(replacement);
    const retirement = session.adoptPrepared(replacement, "/two");

    expect(initial.registry.eventBusPhase).toBe("closed");
    expect(session.current).toBe(replacement);
    expect(session.cwd).toBe("/two");
    expect(session.startCurrent()).toBe(true);
    expect(events).toEqual(["initial:start:/one", "initial:stop", "replacement:start:/two"]);
    release();
    await retirement;
    await session.shutdown();
    expect(events).toEqual([
      "initial:start:/one",
      "initial:stop",
      "replacement:start:/two",
      "replacement:stop",
    ]);
  });

  test("owns aliases by registry identity and retires multiple provisional registries once", async () => {
    const events: string[] = [];
    const initial = loadResult("initial", events);
    const first = loadResult("first", events);
    const alias = { ...first };
    const second = loadResult("second", events);
    const session = createExtensionSession(initial, "/repo");

    session.trackPrepared(first);
    session.trackPrepared(alias);
    session.trackPrepared(second);
    await session.retirePrepared();
    await session.retirePrepared(first);
    await session.shutdown();
    await session.shutdown();

    expect(events.filter((event) => event === "first:stop")).toHaveLength(1);
    expect(events.filter((event) => event === "second:stop")).toHaveLength(1);
    expect(events.filter((event) => event === "initial:stop")).toHaveLength(1);
  });

  test("closes synchronously and drains provisional authority published during shutdown", async () => {
    const events: string[] = [];
    let releaseInitial!: () => void;
    let releaseLate!: () => void;
    const initialWait = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const lateWait = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const initial = loadResult("initial", events, () => initialWait);
    const late = loadResult("late", events, () => lateWait);
    const session = createExtensionSession(initial, "/repo");

    const shutdown = session.shutdown();
    expect(session.closing).toBe(true);
    expect(session.startCurrent()).toBe(false);
    session.trackPrepared(late);
    expect(late.registry.eventBusPhase).toBe("closed");

    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    releaseInitial();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseLate();
    await shutdown;
    expect(events).toEqual(["initial:stop", "late:stop"]);
  });

  test("a later shutdown call drains provisional work tracked after shutdown settled", async () => {
    const events: string[] = [];
    let releaseLate!: () => void;
    const lateWait = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const session = createExtensionSession(loadResult("initial", events), "/repo");
    await session.shutdown();

    const late = loadResult("late", events, () => lateWait);
    session.trackPrepared(late);
    let settled = false;
    const barrier = session.shutdown().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(late.registry.eventBusPhase).toBe("closed");

    releaseLate();
    await barrier;
    expect(events).toEqual(["initial:stop", "late:stop"]);
  });

  test("rejects adoption after closing and registries not staged by the session", async () => {
    const events: string[] = [];
    const session = createExtensionSession(loadResult("initial", events), "/repo");
    const foreign = loadResult("foreign", events);
    expect(() => session.adoptPrepared(foreign, "/other")).toThrow("not prepared");
    await session.shutdown();
    expect(() => session.adoptPrepared(foreign, "/other")).toThrow("shutting down");
  });
});
