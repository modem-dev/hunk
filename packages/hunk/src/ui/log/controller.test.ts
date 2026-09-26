import { describe, expect, test } from "bun:test";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import type { HistoryRuntime } from "../history/types";
import { LogController } from "./controller";

function createRuntime(subjects = ["first", "second", "third"], notices: readonly string[] = []) {
  let cursor = 0;
  let closeCount = 0;
  const makeSource = () => ({
    async read({ limit }: { limit: number; signal?: AbortSignal }) {
      const selected = subjects.slice(cursor, cursor + Math.min(limit, 2));
      cursor += selected.length;
      return {
        commits: selected.map((subject) => ({
          revisionId: subject,
          displayId: subject.slice(0, 8),
          parentRevisionIds: [],
          subject,
          authorName: "Ada",
          authoredAt: "2026-01-01T00:00:00Z",
          decorations: [],
        })),
        done: cursor >= subjects.length,
      };
    },
    async close() {},
  });
  let source = makeSource();
  const runtime: HistoryRuntime = {
    input: {
      kind: "history",
      color: "never",
      format: "compact",
      ascii: false,
      static: false,
      extensionsEnabled: false,
      extensionPaths: [],
    },
    source,
    extensionSession: createTestExtensionSession(),
    providerId: "test",
    providerName: "Test",
    repoRoot: "/repo",
    notices,
    customThemes: [],
    keybindings: {},
    initialViewPreferences: persistedViewPreferencesFromOptions({}),
    promptSaveViewPreferences: true,
    async planReview(commit) {
      return { kind: "revision-show", revisionId: commit.revisionId };
    },
    async reopenSource() {
      cursor = 0;
      source = makeSource();
      return source;
    },
    async close() {
      closeCount += 1;
    },
  };
  return { runtime, closeCount: () => closeCount };
}

describe("LogController", () => {
  test("preserves bootstrap notices when keymap diagnostics arrive after mount", async () => {
    const { runtime } = createRuntime(undefined, [
      "Configured VCS is unavailable.",
      "Extension registration was skipped.",
    ]);
    const controller = new LogController(runtime);

    controller.addStartupNotices(["Unknown history command."]);
    controller.addStartupNotices(["Unknown history command."]);

    expect(controller.getSnapshot().notice).toBe(
      "Configured VCS is unavailable. • Extension registration was skipped. • Unknown history command.",
    );
    await controller.close();
  });

  test("loads bounded pages and retains navigation/search state", async () => {
    const { runtime } = createRuntime();
    const controller = new LogController(runtime);
    expect(controller.getSnapshot().presentation.graph).toBe(false);
    await controller.loadMore();
    expect(controller.getSnapshot().rows.map((row) => row.commit.subject)).toEqual([
      "first",
      "second",
    ]);
    controller.move(1, 1);
    expect(controller.getSnapshot().selected).toBe(1);
    await controller.search("third");
    expect(controller.getSnapshot().search).toBe("third");
    expect(controller.getSnapshot().rows).toHaveLength(3);
    expect(controller.getSnapshot().selected).toBe(2);
    // The query stays repeatable after the prompt closes.
    await controller.findMatch(1);
    expect(controller.getSnapshot().selected).toBe(2);
    expect(controller.getSnapshot().notice).toBe("");
    await controller.close();
  });

  test("forces ASCII graph presentation for TERM=dumb", async () => {
    const previous = process.env.TERM;
    process.env.TERM = "dumb";
    try {
      const { runtime } = createRuntime();
      const controller = new LogController(runtime);
      expect(controller.getSnapshot().presentation.unicode).toBe(false);
      await controller.close();
    } finally {
      if (previous === undefined) delete process.env.TERM;
      else process.env.TERM = previous;
    }
  });

  test("loads enough bounded pages for responsive navigation", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four", "five"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.page(1, 16);
    expect(controller.getSnapshot().selected).toBe(2);
    await controller.page(1, 16);
    expect(controller.getSnapshot().selected).toBe(4);
    expect(controller.getSnapshot().historyDone).toBe(true);
    await controller.close();
  });

  test("moves by half of the visible commit rows", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four", "five"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.loadMore();
    await controller.halfPage(1, 10);
    expect(controller.getSnapshot().selected).toBe(1);
    await controller.halfPage(1, 10);
    expect(controller.getSnapshot().selected).toBe(2);
    await controller.halfPage(-1, 10);
    expect(controller.getSnapshot().selected).toBe(1);
    await controller.close();
  });

  test("preserves rapid navigation targets while bounded continuation is loading", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await Promise.all([controller.move(1, 1), controller.move(1, 1), controller.move(1, 1)]);
    expect(controller.getSnapshot().selected).toBe(3);
    await controller.close();
  });

  test("extends, shrinks, reverses, and collapses an inclusive range", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(1, 1);
    await Promise.all([
      controller.move(1, 1, { extend: true }),
      controller.move(1, 1, { extend: true }),
    ]);
    expect(controller.getSelection()).toMatchObject({
      newestIndex: 1,
      oldestIndex: 3,
      count: 3,
    });
    await controller.move(-2, 1, { extend: true });
    expect(controller.getSelection()?.count).toBe(1);
    await controller.move(-1, 1, { extend: true });
    expect(controller.getSelection()).toMatchObject({ newestIndex: 0, oldestIndex: 1, count: 2 });
    expect(controller.getSelection()?.focus.commit.revisionId).toBe("one");
    await controller.move(1, 1);
    expect(controller.getSnapshot().selectionAnchor).toBeNull();
    expect(controller.getSelection()?.count).toBe(1);
    await controller.close();
  });

  test("keeps visual selection active while plain movement extends and reverses a range", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(1, 1);

    controller.beginVisualSelection();
    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    await controller.move(2, 1, { extend: controller.getSnapshot().visualSelectionActive });
    expect(controller.getSelection()).toMatchObject({ newestIndex: 1, oldestIndex: 3, count: 3 });
    await controller.move(-2, 1, { extend: controller.getSnapshot().visualSelectionActive });
    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    await controller.move(-1, 1, { extend: controller.getSnapshot().visualSelectionActive });
    expect(controller.getSelection()).toMatchObject({ newestIndex: 0, oldestIndex: 1, count: 2 });
    expect(controller.clearSelection()).toBeTrue();
    expect(controller.getSnapshot()).toMatchObject({
      selected: 0,
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("rejects ranges when traversal options can hide or interleave commits", async () => {
    for (const input of [{ grep: "matching" }, { all: true }]) {
      const { runtime } = createRuntime(["one", "two", "three"]);
      runtime.input = { ...runtime.input, ...input };
      const controller = new LogController(runtime);
      await controller.loadMore();
      controller.beginVisualSelection();
      await controller.move(1, 1, { extend: true });

      expect(controller.getSnapshot().visualSelectionActive).toBeFalse();
      expect(controller.getSelection()?.count).toBe(1);
      expect(controller.getSnapshot().notice).toBe(
        "Multi-commit selection is unavailable when history traversal can hide or interleave commits.",
      );
      await controller.close();
    }
  });

  test("Escape-style clearing wins over a deferred visual selection move", async () => {
    const { runtime } = createRuntime(["one", "two", "three"]);
    const originalRead = runtime.source.read.bind(runtime.source);
    let readCount = 0;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.source.read = async (options) => {
      readCount += 1;
      if (readCount === 2) await deferred;
      return originalRead(options);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(1, 1);
    controller.beginVisualSelection();
    const pendingMove = controller.move(1, 1, { extend: true });

    expect(controller.clearSelection()).toBeTrue();
    release();
    await pendingMove;

    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("settles deferred navigation and prevents stale selection overwrite", async () => {
    const { runtime } = createRuntime(["one", "two", "three"]);
    const originalRead = runtime.source.read.bind(runtime.source);
    let readCount = 0;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.source.read = async (options) => {
      readCount += 1;
      if (readCount === 2) await deferred;
      return originalRead(options);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    const staleExtension = controller.move(2, 1, { extend: true });
    const latestSelection = controller.select(0, 1);
    release();
    await Promise.all([staleExtension, latestSelection, controller.settleNavigation()]);
    expect(controller.getSnapshot()).toMatchObject({ selected: 0, selectionAnchor: null });
    await controller.close();
  });

  test("refresh reconciles both range endpoints by immutable revision id", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(2, 2, { extend: true });
    expect(controller.getSelection()?.count).toBe(3);
    await controller.refresh();
    expect(controller.getSelection()?.newest.commit.revisionId).toBe("one");
    expect(controller.getSelection()?.oldest.commit.revisionId).toBe("three");
    expect(controller.getSelection()?.count).toBe(3);
    await controller.close();
  });

  test("entering visual selection during refresh preserves the new mode", async () => {
    const { runtime } = createRuntime(["one", "two", "three"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      markStarted();
      await deferred;
      return reopenSource(signal);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(1, 2);

    const refresh = controller.refresh();
    await started;
    controller.beginVisualSelection();
    release();
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    await controller.close();
  });

  test("entering visual selection while refreshed rows load preserves the new mode", async () => {
    const { runtime } = createRuntime(["one", "two", "three"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      const replacement = await reopenSource(signal);
      return {
        async read(options) {
          markStarted();
          await deferred;
          return replacement.read(options);
        },
        close: () => replacement.close(),
      };
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(1, 2);

    const refresh = controller.refresh();
    await started;
    expect(controller.getSnapshot().rows).toHaveLength(0);
    controller.beginVisualSelection();
    release();
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    await controller.close();
  });

  test("visual selection entered during refresh clears when history becomes empty", async () => {
    const { runtime } = createRuntime(["one"]);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async () => ({
      async read() {
        markStarted();
        await deferred;
        return { commits: [], done: true };
      },
      async close() {},
    });
    const controller = new LogController(runtime);
    await controller.loadMore();

    const refresh = controller.refresh();
    await started;
    controller.beginVisualSelection();
    release();
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      rows: [],
      selected: 0,
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("clearing visual selection during refresh prevents range restoration", async () => {
    const { runtime } = createRuntime(["one", "two", "three"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      markStarted();
      await deferred;
      return reopenSource(signal);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    controller.beginVisualSelection();
    await controller.move(1, 2, { extend: true });

    const refresh = controller.refresh();
    await started;
    expect(controller.clearSelection()).toBeTrue();
    release();
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("search reveals its match and refresh preserves immutable selection viewport offset", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(2, 8);
    expect(controller.getSnapshot().top).toBe(1);
    controller.setSearch("four");
    await controller.findMatch(1, 8);
    expect(controller.getSnapshot()).toMatchObject({ selected: 3, top: 2 });
    await controller.refresh();
    expect(
      controller.getSnapshot().rows[controller.getSnapshot().selected]?.commit.revisionId,
    ).toBe("four");
    expect(controller.getSnapshot().selected - controller.getSnapshot().top).toBe(1);
    await controller.close();
  });

  test("closes a replacement cursor when quit wins a refresh race", async () => {
    let resolveReplacement!: (source: HistoryRuntime["source"]) => void;
    let replacementCloseCount = 0;
    let reopenSignal: AbortSignal | undefined;
    const { runtime } = createRuntime(["one"]);
    runtime.reopenSource = (signal) => {
      reopenSignal = signal;
      return new Promise((resolve) => {
        resolveReplacement = resolve;
      });
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    const refresh = controller.refresh();
    await Promise.resolve();
    const close = controller.close();
    resolveReplacement({
      async read() {
        return { commits: [], done: true };
      },
      async close() {
        replacementCloseCount += 1;
      },
    });
    await Promise.all([refresh, close]);
    expect(reopenSignal?.aborted).toBe(true);
    expect(replacementCloseCount).toBe(1);
  });

  test("closing while replacement rows load settles the pending refresh", async () => {
    const { runtime } = createRuntime(["one", "two"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      const replacement = await reopenSource(signal);
      return {
        async read(options) {
          markStarted();
          await deferred;
          return replacement.read(options);
        },
        close: () => replacement.close(),
      };
    };
    const controller = new LogController(runtime);
    await controller.loadMore();

    const refresh = controller.refresh();
    await started;
    const close = controller.close();
    release();
    await Promise.all([refresh, close]);
  });

  test("refreshes through the provider-owned cursor factory and closes once", async () => {
    const { runtime, closeCount } = createRuntime(["first"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.refresh();
    expect(controller.getSnapshot().rows).toHaveLength(1);
    await controller.close();
    await controller.close();
    expect(closeCount()).toBe(1);
  });
});
