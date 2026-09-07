import { describe, expect, test } from "bun:test";
import { createExtensionNotificationHub } from "./notifications";

describe("extension notification hub", () => {
  test("buffers notifications until a listener attaches, then flushes in order", () => {
    const hub = createExtensionNotificationHub();

    hub.notify("first");
    hub.notify("second", "warning");

    const seen: Array<[string, string]> = [];
    hub.subscribe((notification) => seen.push([notification.message, notification.type]));

    expect(seen).toEqual([
      ["first", "info"],
      ["second", "warning"],
    ]);
  });

  test("delivers straight to an attached listener without buffering", () => {
    const hub = createExtensionNotificationHub();
    const seen: string[] = [];
    hub.subscribe((notification) => seen.push(notification.message));

    hub.notify("live");

    expect(seen).toEqual(["live"]);
  });

  test("re-arms buffering after the listener unsubscribes", () => {
    const hub = createExtensionNotificationHub();
    const first: string[] = [];
    const unsubscribe = hub.subscribe((notification) => first.push(notification.message));

    hub.notify("before");
    unsubscribe();
    hub.notify("while detached");

    const second: string[] = [];
    hub.subscribe((notification) => second.push(notification.message));

    expect(first).toEqual(["before"]);
    expect(second).toEqual(["while detached"]);
  });

  test("assigns increasing ids so the UI can key and retire notifications", () => {
    const hub = createExtensionNotificationHub();
    const ids: number[] = [];
    hub.subscribe((notification) => ids.push(notification.id));

    hub.notify("a");
    hub.notify("b");

    expect(ids[1]).toBeGreaterThan(ids[0]!);
  });

  test("drops the oldest buffered notifications instead of growing without bound", () => {
    const hub = createExtensionNotificationHub();
    for (let index = 0; index < 40; index += 1) {
      hub.notify(`message ${index}`);
    }

    const seen: string[] = [];
    hub.subscribe((notification) => seen.push(notification.message));

    expect(seen.length).toBe(32);
    expect(seen[0]).toBe("message 8");
    expect(seen.at(-1)).toBe("message 39");
  });

  test("keeps notifying when a listener throws", () => {
    const hub = createExtensionNotificationHub();
    hub.subscribe(() => {
      throw new Error("ui exploded");
    });

    expect(() => hub.notify("still fine")).not.toThrow();
  });
});
