import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, Activity, StrictMode, useLayoutEffect, useState } from "react";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import type {
  ExtensionEventPayloads,
  ExtensionLayoutMode,
  ExtensionResolvedLayout,
  ExtensionReviewSnapshotNote,
} from "../../extension-api/types";
import {
  createEmptyExtensionLoadResult,
  type ExtensionDiffFile,
  type ExtensionLoadResult,
} from "../../extensions/types";
import {
  SELECTION_CHANGED_DEBOUNCE_MS,
  useExtensionReviewEvents,
  type ExtensionReviewEventPublishers,
  type ExtensionReviewEventScheduler,
} from "./useExtensionReviewEvents";

interface ScheduledTask {
  callback: () => void;
  canceled: boolean;
  durationMs: number;
}

/** Retain canceled callbacks so tests can prove stale delivery is harmless. */
class TestScheduler implements ExtensionReviewEventScheduler {
  readonly tasks = new Map<number, ScheduledTask>();
  private nextId = 1;

  setTimeout(callback: () => void, durationMs: number) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, canceled: false, durationMs });
    return id;
  }

  clearTimeout(handle: unknown) {
    const task = this.tasks.get(handle as number);
    if (task) task.canceled = true;
  }

  activeIds() {
    return [...this.tasks.entries()].filter(([, task]) => !task.canceled).map(([id]) => id);
  }

  run(id: number, includeCanceled = false) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Missing scheduled task ${id}`);
    this.tasks.delete(id);
    if (!task.canceled || includeCanceled) task.callback();
  }
}

type SeenEvent = { event: string; payload: unknown };

/** Record every review event owned by the publisher hook. */
function observeReviewEvents(extensions: ExtensionLoadResult, seen: SeenEvent[]) {
  extensions.registry.eventHandlers.selection_changed.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "selection_changed", payload });
    },
  });
  extensions.registry.eventHandlers.file_viewed.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "file_viewed", payload });
    },
  });
  extensions.registry.eventHandlers.hunk_viewed.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "hunk_viewed", payload });
    },
  });
  extensions.registry.eventHandlers.filter_changed.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "filter_changed", payload });
    },
  });
  extensions.registry.eventHandlers.layout_changed.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "layout_changed", payload });
    },
  });
  extensions.registry.eventHandlers.theme_changed.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "theme_changed", payload });
    },
  });
  extensions.registry.eventHandlers.watch_reload_pending.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "watch_reload_pending", payload });
    },
  });
  extensions.registry.eventHandlers.note_created.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "note_created", payload });
    },
  });
  extensions.registry.eventHandlers.note_edited.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "note_edited", payload });
    },
  });
  extensions.registry.eventHandlers.note_changed.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "note_changed", payload });
    },
  });
  extensions.registry.eventHandlers.command_executed.push({
    extensionId: "test",
    handler: (payload) => {
      seen.push({ event: "command_executed", payload });
    },
  });
}

interface ReviewEventFacts {
  extensions: ExtensionLoadResult;
  filter: string;
  layoutMode: ExtensionLayoutMode;
  resolvedLayout: ExtensionResolvedLayout;
  reviewGeneration?: string;
  reviewNotes?: readonly ExtensionReviewSnapshotNote[];
  selectedFile: ExtensionDiffFile | null;
  selectedFileId: string | null;
  selectedHunkIndex: number;
  themeId: string;
}

/** Mount the publisher with mutable review facts and an injected deterministic scheduler. */
async function renderReviewEvents({
  initialFacts,
  onLayoutCommit,
  scheduler = new TestScheduler(),
}: {
  initialFacts: ReviewEventFacts;
  onLayoutCommit?: () => void;
  scheduler?: TestScheduler;
}) {
  let publishers!: ExtensionReviewEventPublishers;
  let updateFacts!: (update: Partial<ReviewEventFacts>) => void;

  function Harness() {
    const [facts, setFacts] = useState(initialFacts);
    updateFacts = (update) => setFacts((current) => ({ ...current, ...update }));
    publishers = useExtensionReviewEvents({ ...facts, scheduler });
    useLayoutEffect(() => {
      onLayoutCommit?.();
    }, [facts.extensions, onLayoutCommit]);
    return <text>{facts.selectedFileId ?? "none"}</text>;
  }

  const setup = await testRender(<Harness />, { width: 40, height: 2 });

  /** Flush React effects after changing review facts. */
  const settle = async () => {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
      await setup.renderOnce();
    });
  };

  await settle();
  return {
    current: () => publishers,
    scheduler,
    settle,
    setup,
    updateFacts,
  };
}

/** Destroy one mounted publisher harness. */
async function destroy(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderer.destroy());
}

/** Build one public snapshot note for store-backed note_changed tests. */
function createTestSnapshotNote(id: string, summary = "Explain this"): ExtensionReviewSnapshotNote {
  return {
    id,
    source: "user",
    fileKey: "alpha",
    anchor: { intersectingHunkIndices: [0], ownerHunkIndex: 0 },
    summary,
    editable: true,
    resolution: "active",
  };
}

/** Build the default mounted-review facts for publisher tests. */
function createFacts(extensions: ExtensionLoadResult, selectedFile: ExtensionDiffFile) {
  return {
    extensions,
    filter: "",
    layoutMode: "auto" as const,
    resolvedLayout: "split" as const,
    selectedFile,
    selectedFileId: selectedFile.id,
    selectedHunkIndex: 0,
    themeId: "github-dark-default",
  };
}

describe("useExtensionReviewEvents", () => {
  test("debounces the initial selection while suppressing initial filter, layout, and theme events", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(extensions, file) });

    try {
      expect(seen).toEqual([]);
      const [timerId] = harness.scheduler.activeIds();
      expect(timerId).toBeDefined();
      expect(harness.scheduler.tasks.get(timerId!)?.durationMs).toBe(SELECTION_CHANGED_DEBOUNCE_MS);

      await act(async () => harness.scheduler.run(timerId!));
      expect(seen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);
      expect(seen[0]?.payload).toEqual({ fileId: "alpha", hunkIndex: 0 });
      expect((seen[1]!.payload as ExtensionEventPayloads["file_viewed"]).file.id).toBe("alpha");
    } finally {
      await destroy(harness.setup);
    }
  });

  test("collapses rapid selection changes and ignores a replaced timer even if it fires", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(extensions, alpha) });

    try {
      const [oldTimer] = harness.scheduler.activeIds();
      await act(async () =>
        harness.updateFacts({ selectedFile: beta, selectedFileId: beta.id, selectedHunkIndex: 2 }),
      );
      await harness.settle();
      const [newTimer] = harness.scheduler.activeIds();

      await act(async () => harness.scheduler.run(oldTimer!, true));
      expect(seen).toEqual([]);
      await act(async () => harness.scheduler.run(newTimer!));
      expect(seen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);
      expect(seen[0]?.payload).toEqual({ fileId: "beta", hunkIndex: 2 });
    } finally {
      await destroy(harness.setup);
    }
  });

  test("views a replacement file object after soft reload even when its stable id is unchanged", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const first = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const replacement = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      after: "const replacement = true;\n",
    });
    const harness = await renderReviewEvents({ initialFacts: createFacts(extensions, first) });

    try {
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);
      seen.length = 0;

      await act(async () => harness.updateFacts({ selectedFile: replacement }));
      await harness.settle();
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);

      expect(seen.map(({ event }) => event)).toEqual(["selection_changed", "file_viewed"]);
      expect((seen[1]!.payload as ExtensionEventPayloads["file_viewed"]).file).toBeDefined();
      expect((seen[1]!.payload as ExtensionEventPayloads["file_viewed"]).file.id).toBe("alpha");
    } finally {
      await destroy(harness.setup);
    }
  });

  test("emits hunk_viewed when hunkIndex changes on the same file without re-emitting file_viewed", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(extensions, file) });

    try {
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);
      seen.length = 0;

      await act(async () => harness.updateFacts({ selectedHunkIndex: 2 }));
      await harness.settle();
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);

      expect(seen.map(({ event }) => event)).toEqual(["selection_changed", "hunk_viewed"]);
      expect(seen[0]?.payload).toEqual({ fileId: "alpha", hunkIndex: 2 });
      expect((seen[1]!.payload as ExtensionEventPayloads["hunk_viewed"]).hunkIndex).toBe(2);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("does not emit hunk_viewed when the settled selection has no hunk", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(extensions, file) });

    try {
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);
      seen.length = 0;

      await act(async () => harness.updateFacts({ selectedFile: null, selectedFileId: null }));
      await harness.settle();
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);

      expect(seen.map(({ event }) => event)).toEqual(["selection_changed"]);
      expect(seen[0]?.payload).toEqual({ fileId: null, hunkIndex: null });
    } finally {
      await destroy(harness.setup);
    }
  });

  test("publishes only committed filter, layout, and theme identity changes", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(extensions, file) });

    try {
      await act(async () => harness.updateFacts({}));
      await harness.settle();
      expect(seen).toEqual([]);

      await act(async () =>
        harness.updateFacts({
          filter: "src/",
          layoutMode: "stack",
          resolvedLayout: "stack",
          themeId: "github-light-default",
        }),
      );
      await harness.settle();

      expect(seen).toEqual([
        { event: "filter_changed", payload: { filter: "src/" } },
        { event: "layout_changed", payload: { mode: "stack", layout: "stack" } },
        { event: "theme_changed", payload: { themeId: "github-light-default" } },
      ]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("blocks a retired registry timer during the layout-to-passive cleanup window", async () => {
    const firstExtensions = createEmptyExtensionLoadResult("/repo/first");
    const secondExtensions = createEmptyExtensionLoadResult("/repo/second");
    const firstSeen: SeenEvent[] = [];
    const secondSeen: SeenEvent[] = [];
    observeReviewEvents(firstExtensions, firstSeen);
    observeReviewEvents(secondExtensions, secondSeen);
    const scheduler = new TestScheduler();
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    let fireDuringLayout: (() => void) | undefined;
    let layoutFireCount = 0;
    let pendingDuringLayout = false;
    const harness = await renderReviewEvents({
      initialFacts: createFacts(firstExtensions, file),
      onLayoutCommit: () => fireDuringLayout?.(),
      scheduler,
    });

    try {
      const [retiredTimer] = scheduler.activeIds();
      expect(retiredTimer).toBeDefined();
      expect(scheduler.tasks.get(retiredTimer!)?.canceled).toBeFalse();
      fireDuringLayout = () => {
        ++layoutFireCount;
        pendingDuringLayout = scheduler.tasks.get(retiredTimer!)?.canceled === false;
        scheduler.run(retiredTimer!, true);
      };
      await act(async () => harness.updateFacts({ extensions: secondExtensions }));
      fireDuringLayout = undefined;
      await harness.settle();

      expect(layoutFireCount).toBe(1);
      expect(pendingDuringLayout).toBeTrue();
      expect(scheduler.tasks.has(retiredTimer!)).toBeFalse();
      expect(firstSeen).toEqual([]);
      expect(secondSeen).toEqual([]);
      const [currentTimer] = scheduler.activeIds();
      expect(currentTimer).toBeDefined();
      scheduler.run(currentTimer!);
      expect(secondSeen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("establishes file-view projection again after a registry replaces one that already emitted", async () => {
    const firstExtensions = createEmptyExtensionLoadResult("/repo/first");
    const secondExtensions = createEmptyExtensionLoadResult("/repo/second");
    const firstSeen: SeenEvent[] = [];
    const secondSeen: SeenEvent[] = [];
    observeReviewEvents(firstExtensions, firstSeen);
    observeReviewEvents(secondExtensions, secondSeen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(firstExtensions, file) });

    try {
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);
      expect(firstSeen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);

      await act(async () => harness.updateFacts({ extensions: secondExtensions }));
      await harness.settle();
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);

      expect(firstSeen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);
      expect(secondSeen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("suppresses changed projection baselines when a replacement registry first mounts", async () => {
    const firstExtensions = createEmptyExtensionLoadResult("/repo/first");
    const secondExtensions = createEmptyExtensionLoadResult("/repo/second");
    const firstSeen: SeenEvent[] = [];
    const secondSeen: SeenEvent[] = [];
    observeReviewEvents(firstExtensions, firstSeen);
    observeReviewEvents(secondExtensions, secondSeen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(firstExtensions, file) });

    try {
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);
      await act(async () =>
        harness.updateFacts({
          extensions: secondExtensions,
          filter: "src/",
          layoutMode: "stack",
          resolvedLayout: "stack",
          themeId: "github-light-default",
        }),
      );
      await harness.settle();

      expect(secondSeen).toEqual([]);
      harness.scheduler.run(harness.scheduler.activeIds()[0]!);
      expect(secondSeen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);

      await act(async () =>
        harness.updateFacts({
          filter: "test/",
          layoutMode: "auto",
          resolvedLayout: "split",
          themeId: "github-dark-default",
        }),
      );
      await harness.settle();
      expect(secondSeen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
        "filter_changed",
        "layout_changed",
        "theme_changed",
      ]);
      expect(secondSeen.slice(3)).toEqual([
        { event: "filter_changed", payload: { filter: "test/" } },
        { event: "layout_changed", payload: { mode: "auto", layout: "split" } },
        { event: "theme_changed", payload: { themeId: "github-dark-default" } },
      ]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("retires delayed work from a replaced registry and routes imperative events to the current one", async () => {
    const firstExtensions = createEmptyExtensionLoadResult("/repo/first");
    const secondExtensions = createEmptyExtensionLoadResult("/repo/second");
    const firstSeen: SeenEvent[] = [];
    const secondSeen: SeenEvent[] = [];
    observeReviewEvents(firstExtensions, firstSeen);
    observeReviewEvents(secondExtensions, secondSeen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(firstExtensions, file) });

    try {
      const stalePublishers = harness.current();
      const [oldTimer] = harness.scheduler.activeIds();
      await act(async () => harness.updateFacts({ extensions: secondExtensions }));
      await harness.settle();
      const [currentTimer] = harness.scheduler.activeIds();

      await act(async () => harness.scheduler.run(oldTimer!, true));
      stalePublishers.publishCommandExecuted("hunk.review.nextHunk");
      stalePublishers.publishWatchReloadPending();
      expect(firstSeen).toEqual([]);
      expect(secondSeen.map(({ event }) => event)).toEqual([
        "command_executed",
        "watch_reload_pending",
      ]);

      harness.scheduler.run(currentTimer!);
      expect(secondSeen.map(({ event }) => event)).toEqual([
        "command_executed",
        "watch_reload_pending",
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("publishes note payloads and command ids through narrow imperative publishers", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(extensions, file) });
    const note = {
      id: "note-1",
      fileId: "alpha",
      filePath: "alpha.ts",
      hunkIndex: 0,
      side: "new" as const,
      line: 4,
      body: "Explain this",
      draft: false,
    };

    try {
      harness.current().publishNoteEvent("note_created", { note });
      harness.current().publishNoteEvent("note_edited", { note: { ...note, draft: true } });
      harness.current().publishCommandExecuted("hunk.review.nextHunk");

      expect(seen.map(({ event }) => event)).toEqual([
        "note_created",
        "note_edited",
        "command_executed",
      ]);
      expect(seen[0]?.payload).toEqual({ note });
    } finally {
      await destroy(harness.setup);
    }
  });

  test("does not emit note_changed for the initial saved-note list", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({
      initialFacts: {
        ...createFacts(extensions, file),
        reviewGeneration: "gen-1",
        reviewNotes: [createTestSnapshotNote("user:1")],
      },
    });

    try {
      await harness.settle();
      expect(seen.filter(({ event }) => event === "note_changed")).toEqual([]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("emits note_changed for saved-note mutations within one review generation", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const first = createTestSnapshotNote("user:1", "before");
    const harness = await renderReviewEvents({
      initialFacts: {
        ...createFacts(extensions, file),
        reviewGeneration: "gen-1",
        reviewNotes: [first],
      },
    });

    try {
      await harness.settle();
      const updated = createTestSnapshotNote("user:1", "after");
      const created = createTestSnapshotNote("live:1", "agent");
      await act(async () => harness.updateFacts({ reviewNotes: [updated, created] }));
      await harness.settle();

      expect(
        seen.filter(({ event }) => event === "note_changed").map(({ payload }) => payload),
      ).toEqual([
        { kind: "updated", note: updated },
        { kind: "created", note: created },
      ]);

      await act(async () => harness.updateFacts({ reviewNotes: [created] }));
      await harness.settle();
      expect(seen.filter(({ event }) => event === "note_changed").at(-1)?.payload).toEqual({
        kind: "removed",
        note: updated,
      });
    } finally {
      await destroy(harness.setup);
    }
  });

  test("does not emit note_changed when a reload replaces the note list", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({
      initialFacts: {
        ...createFacts(extensions, file),
        reviewGeneration: "gen-1",
        reviewNotes: [createTestSnapshotNote("user:1")],
      },
    });

    try {
      await harness.settle();
      await act(async () =>
        harness.updateFacts({
          reviewGeneration: "gen-2",
          reviewNotes: [createTestSnapshotNote("live:1", "agent")],
        }),
      );
      await harness.settle();
      expect(seen.filter(({ event }) => event === "note_changed")).toEqual([]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("cancels and invalidates the pending selection callback on unmount", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const harness = await renderReviewEvents({ initialFacts: createFacts(extensions, file) });
    const activeBeforeUnmount = harness.scheduler.activeIds();

    expect(activeBeforeUnmount).toHaveLength(1);
    const [pendingTimer] = activeBeforeUnmount;
    expect(pendingTimer).toBeDefined();
    expect(harness.scheduler.tasks.has(pendingTimer!)).toBeTrue();
    expect(harness.scheduler.tasks.get(pendingTimer!)?.canceled).toBeFalse();

    await destroy(harness.setup);
    expect(harness.scheduler.tasks.get(pendingTimer!)?.canceled).toBeTrue();
    harness.scheduler.run(pendingTimer!, true);
    expect(seen).toEqual([]);
  });

  test("retires and replaces selection timers through explicit StrictMode effect replay", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const seen: SeenEvent[] = [];
    observeReviewEvents(extensions, seen);
    const scheduler = new TestScheduler();
    const file = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const facts = createFacts(extensions, file);
    let setVisible!: (visible: boolean) => void;

    function EventHarness() {
      useExtensionReviewEvents({ ...facts, scheduler });
      return <text>events</text>;
    }

    function ReplayHarness() {
      const [visible, updateVisible] = useState(true);
      setVisible = updateVisible;
      return (
        <StrictMode>
          <Activity mode={visible ? "visible" : "hidden"}>
            <EventHarness />
          </Activity>
        </StrictMode>
      );
    }

    const setup = await testRender(<ReplayHarness />, { width: 40, height: 2 });
    const settle = async () => {
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(0);
        await setup.renderOnce();
      });
    };

    try {
      await settle();
      const initialActive = scheduler.activeIds();
      expect(initialActive).toHaveLength(1);
      const [initialTimer] = initialActive;
      expect(scheduler.tasks.get(initialTimer!)?.canceled).toBeFalse();

      await act(async () => setVisible(false));
      await settle();
      expect(scheduler.activeIds()).toEqual([]);
      expect(scheduler.tasks.get(initialTimer!)?.canceled).toBeTrue();

      await act(async () => setVisible(true));
      await settle();
      const replayActive = scheduler.activeIds();
      expect(replayActive).toHaveLength(1);
      const [currentTimer] = replayActive;
      expect(currentTimer).toBeDefined();
      expect(currentTimer).not.toBe(initialTimer);
      expect(scheduler.tasks.get(currentTimer!)?.canceled).toBeFalse();
      expect(scheduler.tasks.size).toBeGreaterThanOrEqual(2);
      expect(
        [...scheduler.tasks.entries()].some(([id, task]) => id !== currentTimer && task.canceled),
      ).toBeTrue();

      scheduler.run(initialTimer!, true);
      expect(seen).toEqual([]);
      scheduler.run(currentTimer!);
      expect(seen.map(({ event }) => event)).toEqual([
        "selection_changed",
        "file_viewed",
        "hunk_viewed",
      ]);
    } finally {
      await destroy(setup);
    }
  });
});
