import { describe, expect, test } from "bun:test";
import {
  emitExtensionEvent,
  emitExtensionEventBounded,
  emitExtensionEventToExtensions,
} from "./events";
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

/** Build a minimal changeset shaped the way the review pipeline produces one. */
function createTestChangeset() {
  return {
    id: "changeset-1",
    sourceLabel: "repo",
    title: "working tree",
    files: [
      {
        id: "file-1",
        path: "a.ts",
        patch: "",
        stats: { additions: 1, deletions: 0 },
        metadata: { hunks: [] },
        agent: null,
      },
    ],
  };
}

describe("changeset payloads handed to event handlers", () => {
  test("a handler that pushes onto files fails without touching the live changeset", () => {
    const changeset = createTestChangeset();
    const liveFiles = changeset.files;
    const { result, notices } = createTestLoadResult([
      {
        extensionId: "mutator",
        event: "changeset_loaded",
        handler: (payload) => {
          // The exact mutation that used to corrupt the array the review UI
          // renders from and take the app down on the next render.
          (payload as { changeset: { files: unknown[] } }).changeset.files.push({
            id: "garbage",
          });
        },
      },
    ]);

    emitExtensionEvent(result, "changeset_loaded", { changeset } as never);

    // The failure is contained where the isolation contract already reports it.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Extension mutator failed handling changeset_loaded");
    // App state is exactly as it was: same array, same length, same identity.
    expect(changeset.files).toBe(liveFiles);
    expect(changeset.files).toHaveLength(1);
  });

  test("a handler cannot reassign changeset fields or replace files", () => {
    const changeset = createTestChangeset();
    const failures: string[] = [];
    const { result } = createTestLoadResult([
      {
        extensionId: "mutator",
        event: "session_reload",
        handler: (payload) => {
          const view = (payload as unknown as { changeset: Record<string, unknown> }).changeset;
          try {
            view.title = "hijacked";
          } catch (error) {
            failures.push(`title:${(error as Error).name}`);
          }
          try {
            (view.files as unknown[])[0] = { id: "swapped" };
          } catch (error) {
            failures.push(`file:${(error as Error).name}`);
          }
        },
      },
    ]);

    emitExtensionEvent(result, "session_reload", { changeset, reason: "manual" } as never);

    expect(failures).toEqual(["title:TypeError", "file:TypeError"]);
    expect(changeset.title).toBe("working tree");
    expect(changeset.files[0]?.id).toBe("file-1");
  });

  test("handlers still read the changeset's real contents", () => {
    const changeset = createTestChangeset();
    const seen: string[] = [];
    const { result, notices } = createTestLoadResult([
      {
        extensionId: "reader",
        event: "changeset_loaded",
        handler: (payload) => {
          const view = (payload as { changeset: ReturnType<typeof createTestChangeset> }).changeset;
          seen.push(`${view.title}:${view.files.length}:${view.files[0]?.path}`);
        },
      },
    ]);

    emitExtensionEvent(result, "changeset_loaded", { changeset } as never);

    expect(seen).toEqual(["working tree:1:a.ts"]);
    expect(notices).toEqual([]);
  });

  test("payloads without a changeset are copied and frozen, not passed by reference", () => {
    const payload = { fileId: "file-1", hunkIndex: 2 };
    const seen: unknown[] = [];
    const { result } = createTestLoadResult([
      {
        extensionId: "reader",
        event: "selection_changed",
        handler: (received) => {
          seen.push(received);
        },
      },
    ]);

    emitExtensionEvent(result, "selection_changed", payload);

    // Same contents, but the handler cannot reach the caller's object.
    expect(seen[0]).toEqual(payload);
    expect(seen[0]).not.toBe(payload);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  test("one handler cannot change the payload a later handler sees", () => {
    const changeset = createTestChangeset();
    const seen: unknown[] = [];
    const { result } = createTestLoadResult([
      {
        extensionId: "deleter",
        event: "changeset_loaded",
        handler: (payload) => {
          delete (payload as unknown as { changeset?: unknown }).changeset;
        },
      },
      {
        extensionId: "reader",
        event: "changeset_loaded",
        handler: (payload) => {
          seen.push((payload as { changeset?: { title?: string } }).changeset?.title);
        },
      },
    ]);

    emitExtensionEvent(result, "changeset_loaded", { changeset } as never);

    expect(seen).toEqual(["working tree"]);
  });
});

describe("emitExtensionEventToExtensions", () => {
  test("delivers only to the named extensions", () => {
    const seen: string[] = [];
    const { result } = createTestLoadResult([
      {
        extensionId: "already-started",
        event: "startup",
        handler: () => {
          seen.push("already-started");
        },
      },
      {
        extensionId: "newly-trusted",
        event: "startup",
        handler: () => {
          seen.push("newly-trusted");
        },
      },
    ]);

    emitExtensionEventToExtensions(result, "startup", { cwd: "/repo" }, new Set(["newly-trusted"]));

    expect(seen).toEqual(["newly-trusted"]);
  });

  test("does nothing when the id set is empty", () => {
    const seen: string[] = [];
    const { result } = createTestLoadResult([
      {
        extensionId: "any",
        event: "startup",
        handler: () => {
          seen.push("any");
        },
      },
    ]);

    emitExtensionEventToExtensions(result, "startup", { cwd: "/repo" }, new Set());

    expect(seen).toEqual([]);
  });

  test("still isolates a throwing handler", () => {
    const { result, notices } = createTestLoadResult([
      {
        extensionId: "broken",
        event: "startup",
        handler: () => {
          throw new Error("boom");
        },
      },
    ]);

    emitExtensionEventToExtensions(result, "startup", { cwd: "/repo" }, new Set(["broken"]));

    expect(notices[0]).toContain("Extension broken failed handling startup • boom");
  });
});
