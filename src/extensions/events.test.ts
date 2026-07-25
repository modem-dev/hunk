import { describe, expect, test } from "bun:test";
import { emitExtensionEvent, emitExtensionEventBounded } from "./events";
import { createExtensionNotificationHub } from "./notifications";
import {
  createEmptyExtensionLoadResult,
  type ExtensionEventHandler,
  type ExtensionEventName,
  type ExtensionLoadResult,
} from "./types";

/** Build a load result whose registry holds only the handlers a test cares about. */
function createTestLoadResult(
  handlers: Array<{
    extensionId: string;
    event: ExtensionEventName;
    handler: ExtensionEventHandler;
  }> = [],
): { result: ExtensionLoadResult; notices: string[] } {
  const notifications = createExtensionNotificationHub();
  const notices: string[] = [];
  notifications.subscribe((notification) => notices.push(notification.message));

  const result = createEmptyExtensionLoadResult("/repo", notifications);
  for (const { extensionId, event, handler } of handlers) {
    result.registry.eventHandlers[event].push({ extensionId, handler });
  }

  return { result, notices };
}

describe("extension event dispatch", () => {
  test("invokes every handler for one event with the shared context", () => {
    const seen: Array<string> = [];
    const { result } = createTestLoadResult([
      {
        extensionId: "first",
        event: "startup",
        handler: (payload, ctx) => {
          seen.push(`first:${(payload as { cwd: string }).cwd}:${ctx.cwd}`);
        },
      },
      {
        extensionId: "second",
        event: "startup",
        handler: () => {
          seen.push("second");
        },
      },
    ]);

    emitExtensionEvent(result, "startup", { cwd: "/repo" });

    expect(seen).toEqual(["first:/repo:/repo", "second"]);
  });

  test("isolates a throwing handler and keeps dispatching the rest", () => {
    const seen: string[] = [];
    const { result, notices } = createTestLoadResult([
      {
        extensionId: "broken",
        event: "startup",
        handler: () => {
          throw new Error("handler blew up");
        },
      },
      {
        extensionId: "healthy",
        event: "startup",
        handler: () => {
          seen.push("healthy");
        },
      },
    ]);

    emitExtensionEvent(result, "startup", { cwd: "/repo" });

    expect(seen).toEqual(["healthy"]);
    expect(notices).toEqual(["Extension broken failed handling startup • handler blew up"]);
  });

  test("reports a rejected async handler without surfacing the rejection", async () => {
    const { result, notices } = createTestLoadResult([
      {
        extensionId: "slow",
        event: "changeset_loaded",
        handler: async () => {
          throw new Error("async failure");
        },
      },
    ]);

    await emitExtensionEventBounded(result, "changeset_loaded", {
      changeset: { id: "c", sourceLabel: "repo", title: "t", files: [] },
    });

    expect(notices).toEqual(["Extension slow failed handling changeset_loaded • async failure"]);
  });

  test("does not wait on async handlers when emitting fire-and-forget", async () => {
    let resolveHandler = () => {};
    const finished: string[] = [];
    const { result } = createTestLoadResult([
      {
        extensionId: "slow",
        event: "selection_changed",
        handler: () =>
          new Promise<void>((resolve) => {
            resolveHandler = () => {
              finished.push("handler");
              resolve();
            };
          }),
      },
    ]);

    emitExtensionEvent(result, "selection_changed", { fileId: "a", hunkIndex: 0 });
    finished.push("caller");
    resolveHandler();
    await Promise.resolve();

    expect(finished[0]).toBe("caller");
  });

  test("gives up on a hanging shutdown handler after the bound", async () => {
    const { result } = createTestLoadResult([
      {
        extensionId: "hanging",
        event: "shutdown",
        handler: () => new Promise<void>(() => {}),
      },
    ]);

    const started = Date.now();
    await emitExtensionEventBounded(result, "shutdown", {}, 20);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("is a no-op when the session has no extensions", () => {
    expect(() => emitExtensionEvent(undefined, "startup", { cwd: "/repo" })).not.toThrow();
  });
});
