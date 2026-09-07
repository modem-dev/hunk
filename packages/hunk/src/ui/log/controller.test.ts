import { describe, expect, test } from "bun:test";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import type { HistoryRuntime } from "../history/types";
import { LogController } from "./controller";

function createRuntime(subjects = ["first", "second", "third"]) {
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
    notices: [],
    customThemes: [],
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
    controller.setSearch("");
    controller.appendSearch("th");
    controller.appendSearch("ird");
    expect(controller.getSnapshot().search).toBe("third");
    controller.backspaceSearch();
    controller.appendSearch("d");
    await controller.findMatch(1);
    expect(controller.getSnapshot().rows).toHaveLength(3);
    expect(controller.getSnapshot().selected).toBe(2);
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

  test("rejects ranges when traversal options can hide or interleave commits", async () => {
    for (const input of [{ grep: "matching" }, { all: true }]) {
      const { runtime } = createRuntime(["one", "two", "three"]);
      runtime.input = { ...runtime.input, ...input };
      const controller = new LogController(runtime);
      await controller.loadMore();
      await controller.move(1, 1, { extend: true });

      expect(controller.getSelection()?.count).toBe(1);
      expect(controller.getSnapshot().notice).toBe(
        "Multi-commit selection is unavailable when history traversal can hide or interleave commits.",
      );
      await controller.close();
    }
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

  test("refreshes through the provider-owned cursor factory and closes once", async () => {
    const { runtime, closeCount } = createRuntime(["first"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    controller.setTheme("github-dark");
    await controller.refresh();
    expect(controller.getSnapshot().rows).toHaveLength(1);
    expect(controller.getSnapshot().themeId).toBe("github-dark");
    await controller.close();
    await controller.close();
    expect(closeCount()).toBe(1);
  });
});
