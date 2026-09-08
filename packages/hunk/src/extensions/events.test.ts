import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import {
  bindExtensionEventBus,
  emitExtensionCustomEvent,
  emitExtensionEvent,
  emitExtensionEventBounded,
  readMetadataHunkCount,
  readMetadataHunkSummaries,
  retireExtensionLoadResult,
  toReadOnlyFileViews,
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

  test("reports named command execution with an immutable payload", () => {
    let seen: { commandId: string } | undefined;
    const { result } = createTestLoadResult([
      {
        extensionId: "coach",
        event: "command_executed",
        handler: (payload) => {
          seen = payload as { commandId: string };
        },
      },
    ]);

    emitExtensionEvent(result, "command_executed", { commandId: "hunk.review.nextHunk" });

    expect(seen).toEqual({ commandId: "hunk.review.nextHunk" });
    expect(Object.isFrozen(seen)).toBe(true);
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

  test("refuses review reloads before the mounted app installs live controls", async () => {
    let reloadResult:
      | Awaited<
          ReturnType<Parameters<ExtensionEventHandler<"startup">>[1]["review"]["requestReload"]>
        >
      | undefined;
    const { result, notices } = createTestLoadResult([
      {
        extensionId: "agent",
        event: "startup",
        handler: async (_payload, ctx) => {
          reloadResult = await ctx.review.requestReload();
        },
      },
    ]);

    await emitExtensionEventBounded(result, "startup", { cwd: "/repo" });

    expect(reloadResult).toEqual({
      ok: false,
      reason: "unavailable",
      detail: "The review is not ready to reload.",
    });
    expect(notices).toEqual(["Extension agent cannot reload the review before the app is ready"]);
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

  test("gives lifecycle handlers live pane controls and one deprecated alias", () => {
    const opened: string[] = [];
    let aliasesSame = false;
    const { result } = createTestLoadResult([
      {
        extensionId: "summary",
        event: "changeset_loaded",
        handler: (_payload, ctx) => {
          aliasesSame = ctx.panes === ctx.sidebars;
          ctx.panes.open("summary");
          ctx.sidebars.open("legacy");
        },
      },
    ]);
    result.eventContextProvider = (extensionId) => {
      const panes = {
        open: (viewId: string) => opened.push(`${extensionId}:${viewId}`),
        close: () => {},
        toggle: () => {},
        isOpen: () => false,
      };
      return {
        cwd: "/repo",
        notify: () => {},
        panes,
        sidebars: panes,
        navigation: { selectFile: () => {}, selectHunk: () => {}, revealLine: () => {} },
        dialogs: {
          confirm: async () => false,
          select: async () => null,
          input: async () => null,
        },
        review: { requestReload: async () => ({ ok: true }) },
        events: { emit: () => {} },
      };
    };

    emitExtensionEvent(result, "changeset_loaded", {
      changeset: { id: "c", sourceLabel: "repo", title: "t", files: [] },
    });

    expect(aliasesSame).toBe(true);
    expect(opened).toEqual(["summary:summary", "summary:legacy"]);
  });

  test("is a no-op when the session has no extensions", () => {
    expect(() => emitExtensionEvent(undefined, "startup", { cwd: "/repo" })).not.toThrow();
  });
});

describe("extension event bus", () => {
  test("revokes retained contexts before an asynchronous shutdown settles", async () => {
    let retainedContext: Parameters<ExtensionEventHandler<"startup">>[1] | undefined;
    let deliveries = 0;
    const { result } = createTestLoadResult([
      {
        extensionId: "sender",
        event: "startup",
        handler: (_payload, context) => {
          retainedContext = context;
        },
      },
    ]);
    result.registry.customEventHandlers.push({
      extensionId: "receiver",
      event: "probe",
      handler: () => {
        deliveries += 1;
      },
    });
    let releaseShutdown!: () => void;
    result.registry.eventHandlers.shutdown.push({
      extensionId: "sender",
      handler: () => new Promise<void>((resolve) => (releaseShutdown = resolve)),
    });
    bindExtensionEventBus(result);
    emitExtensionEvent(result, "startup", { cwd: "/repo" });

    const retirement = retireExtensionLoadResult(result);
    expect(result.registry.eventBusPhase).toBe("closed");
    retainedContext?.events.emit("probe", {});
    expect(deliveries).toBe(0);

    releaseShutdown();
    await retirement;
  });

  test("shares one retirement completion while shutdown is still pending", async () => {
    const { result } = createTestLoadResult();
    let releaseShutdown!: () => void;
    result.registry.eventHandlers.shutdown.push({
      extensionId: "probe",
      handler: () => new Promise<void>((resolve) => (releaseShutdown = resolve)),
    });
    bindExtensionEventBus(result);

    const first = retireExtensionLoadResult(result);
    const second = retireExtensionLoadResult({ ...result });
    expect(second).toBe(first);

    let settled = false;
    void second.then(() => (settled = true));
    await Bun.sleep(0);
    expect(settled).toBe(false);

    releaseShutdown();
    await Promise.all([first, second]);
  });

  test("drops ordinary lifecycle events after revocation and runs shutdown once", async () => {
    const seen: string[] = [];
    const { result } = createTestLoadResult([
      {
        extensionId: "probe",
        event: "selection_changed",
        handler: () => {
          seen.push("selection");
        },
      },
      {
        extensionId: "probe",
        event: "shutdown",
        handler: () => {
          seen.push("shutdown");
        },
      },
    ]);
    bindExtensionEventBus(result);

    await retireExtensionLoadResult(result);
    emitExtensionEvent(result, "selection_changed", { fileId: null, hunkIndex: null });
    await retireExtensionLoadResult(result);

    expect(seen).toEqual(["shutdown"]);
  });

  test("delivers a namespaced event to every listener and isolates failures", async () => {
    const seen: string[] = [];
    const { result, notices } = createTestLoadResult();
    result.registry.customEventHandlers.push(
      {
        extensionId: "broken",
        event: "summary:ready",
        handler: () => {
          throw new Error("boom");
        },
      },
      {
        extensionId: "sidebar",
        event: "summary:ready",
        handler: (payload) => {
          seen.push((payload as { count: number }).count.toString());
        },
      },
    );
    bindExtensionEventBus(result);

    result.registry.emitCustomEvent?.("summary:ready", { count: 3 });
    emitExtensionCustomEvent(result, "other:event", { count: 4 });
    await Promise.resolve();

    expect(seen).toEqual(["3"]);
    expect(notices).toEqual(["Extension broken failed handling event summary:ready • boom"]);
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

describe("read-only file views", () => {
  /** One file whose nested state a test can try to corrupt. */
  function createTestFile() {
    return {
      id: "file-1",
      path: "a.ts",
      patch: "",
      stats: { additions: 1, deletions: 0 },
      metadata: { type: "change", hunks: [{ header: "@@ -1 +1 @@" }] },
      agent: { path: "a.ts", annotations: [{ summary: "why" }] },
    };
  }

  test("reads reach the shared metadata, writes into it are refused", () => {
    const file = createTestFile();
    const [view] = toReadOnlyFileViews([file as never]);

    // Reads pass through, including the host's own metadata readers.
    expect(readMetadataHunkCount(view!.metadata)).toBe(1);

    const metadata = view!.metadata as { type: string; hunks: { header: string }[] };
    expect(() => {
      metadata.type = "deleted";
    }).toThrow(TypeError);
    expect(() => {
      metadata.hunks.push({ header: "@@ forged @@" });
    }).toThrow(TypeError);
    expect(() => {
      metadata.hunks[0]!.header = "@@ forged @@";
    }).toThrow(TypeError);

    // The live model is exactly as it was.
    expect(file.metadata.type).toBe("change");
    expect(file.metadata.hunks).toHaveLength(1);
    expect(file.metadata.hunks[0]!.header).toBe("@@ -1 +1 @@");
  });

  test("reflection cannot expose or alter the live model", () => {
    const file = createTestFile();
    const [view] = toReadOnlyFileViews([file as never]);
    const metadata = view!.metadata as object;
    const hunks = Object.getOwnPropertyDescriptor(metadata, "hunks")!.value as {
      header: string;
    }[];

    expect(hunks).not.toBe(file.metadata.hunks);
    expect(() => {
      hunks[0]!.header = "@@ forged @@";
    }).toThrow(TypeError);
    expect(() => Object.preventExtensions(metadata)).toThrow(TypeError);
    expect(file.metadata.hunks[0]!.header).toBe("@@ -1 +1 @@");
    expect(Object.isExtensible(file.metadata)).toBe(true);
  });

  test("stats and agent annotations are guarded the same way", () => {
    const file = createTestFile();
    const [view] = toReadOnlyFileViews([file as never]);

    expect(view!.stats.additions).toBe(1);
    expect(() => {
      (view!.stats as { additions: number }).additions = 99;
    }).toThrow(TypeError);
    expect(() => {
      view!.agent!.annotations[0]!.summary = "forged";
    }).toThrow(TypeError);
    expect(file.stats.additions).toBe(1);
    expect(file.agent.annotations[0]!.summary).toBe("why");
  });

  test("converting the same file again hands out the identical guarded objects", () => {
    const file = createTestFile();
    const [first] = toReadOnlyFileViews([file as never]);
    const [second] = toReadOnlyFileViews([file as never]);

    // Cached per source object, so consumers comparing across conversions —
    // sidebar props against a command's selection snapshot — see one identity.
    expect(second!.metadata).toBe(first!.metadata);
    expect(second!.agent).toBe(first!.agent);
  });

  test("exotic objects inside metadata read through unwrapped", () => {
    // A proxy would break internal-slot methods (`Map.prototype.get` on a
    // proxied Map throws), so non-JSON-shaped values pass through as-is.
    const cache = new Map([["k", "v"]]);
    const file = { ...createTestFile(), metadata: { cache } };
    const [view] = toReadOnlyFileViews([file as never]);

    const seen = (view!.metadata as { cache: Map<string, string> }).cache;
    expect(seen).toBe(cache);
    expect(seen.get("k")).toBe("v");
  });

  test("fills hunk summaries from the parsed metadata", () => {
    const file = createTestDiffFile({ context: 0 });
    const [view] = toReadOnlyFileViews([file as never]);

    expect(view!.hunks).toHaveLength(file.metadata.hunks.length);
    expect(view!.hunks!.length).toBeGreaterThan(0);
    for (const [index, summary] of view!.hunks!.entries()) {
      expect(summary.index).toBe(index);
      expect(summary.header).toMatch(/^@@ -\d/);
      expect(summary.oldRange).toBeDefined();
      expect(summary.newRange).toBeDefined();
    }
  });

  test("hunk summaries are frozen and identical across conversions", () => {
    const file = createTestDiffFile();
    const [first] = toReadOnlyFileViews([file as never]);
    const [second] = toReadOnlyFileViews([file as never]);

    // Derived once per parsed diff: views are rebuilt on every emit, so the
    // summaries are keyed by the metadata behind them, like the deep views.
    expect(second!.hunks).toBe(first!.hunks);
    expect(readMetadataHunkSummaries(file.metadata)).toBe(first!.hunks!);

    expect(Object.isFrozen(first!.hunks)).toBe(true);
    expect(Object.isFrozen(first!.hunks![0])).toBe(true);
    expect(() => {
      (first!.hunks as unknown as { header: string }[])[0]!.header = "@@ forged @@";
    }).toThrow(TypeError);
  });

  test("hunk summaries always come from metadata, not from a stale field on the file", () => {
    // A transform that spreads a frozen view carries an old `hunks` list along;
    // the parsed diff is authoritative, so the boundary replaces it.
    const file = { ...createTestFile(), hunks: [{ index: 9, header: "@@ stale @@" }] };
    const [view] = toReadOnlyFileViews([file as never]);

    expect(view!.hunks).toHaveLength(1);
    expect(view!.hunks![0]!.index).toBe(0);
    expect(view!.hunks![0]!.header).not.toBe("@@ stale @@");
  });

  test("files with no parsable hunks share one empty summary list", () => {
    const binary = { ...createTestFile(), id: "bin", metadata: { type: "change" } };
    const skipped = { ...createTestFile(), id: "skip", metadata: null };
    const views = toReadOnlyFileViews([binary as never, skipped as never]);

    expect(views[0]!.hunks).toEqual([]);
    expect(views[1]!.hunks).toBe(views[0]!.hunks);
  });
});
