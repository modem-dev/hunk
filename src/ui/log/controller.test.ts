import { describe, expect, test } from "bun:test";
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
      interactive: true,
      extensionsEnabled: false,
      extensionPaths: [],
    },
    source,
    providerId: "test",
    providerName: "Test",
    repoRoot: "/repo",
    notices: [],
    customThemes: [],
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

  test("initializes format from CLI input and loads enough pages for navigation", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four", "five"]);
    runtime.input.format = "medium";
    const controller = new LogController(runtime);
    expect(controller.getSnapshot().presentation.format).toBe("medium");
    await controller.loadMore();
    await controller.page(1, 4);
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

  test("search reveals its match and refresh preserves immutable selection viewport offset", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(2, 2);
    expect(controller.getSnapshot().top).toBe(1);
    controller.setSearch("four");
    await controller.findMatch(1, 2);
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
