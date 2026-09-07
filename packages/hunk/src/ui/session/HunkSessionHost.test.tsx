import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
import type { HistoryRuntime } from "../history/types";
import { LogController } from "../log/controller";
import {
  HunkSessionHost,
  type HistorySurfaceRoute,
  type HunkSessionHostDeps,
} from "./HunkSessionHost";

mock.restore();

/** Create a loaded one-row history route for session-host navigation tests. */
async function createHistoryRoute() {
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
    extensionSession: createTestExtensionSession(),
    source: {
      async read() {
        return {
          commits: [
            {
              revisionId: "revision-a",
              displayId: "revision",
              parentRevisionIds: [],
              subject: "History row",
              authorName: "Ada",
              authoredAt: "2026-01-01T00:00:00Z",
              decorations: [],
            },
          ],
          done: true,
        };
      },
      async close() {},
    },
    providerId: "test",
    providerName: "Test",
    repoRoot: "/repo",
    notices: [],
    customThemes: [],
    initialViewPreferences: persistedViewPreferencesFromOptions({}),
    promptSaveViewPreferences: true,
    async planReview() {
      return { kind: "revision-show", revisionId: "revision-a" };
    },
    async reopenSource() {
      return this.source;
    },
    async close() {},
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  return { kind: "history", controller, runtime } satisfies HistorySurfaceRoute;
}

/** Select Quit through the live history menu while review preparation owns the input lock. */
async function selectHistoryMenuQuit(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.mockInput.pressKey("f10"));
  await act(async () => setup.mockInput.pressKey("q"));
}

/** Flush async history planning and mounted review shutdown work. */
async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await Bun.sleep(20);
    await setup.renderOnce();
    await Bun.sleep(20);
    await setup.renderOnce();
  });
}

test("routes repeated history reviews through fresh runtimes and returns instead of quitting", async () => {
  const history = await createHistoryRoute();
  const quit = mock(() => undefined);
  const stops: Array<ReturnType<typeof mock>> = [];
  let instance = 0;
  const deps: HunkSessionHostDeps = {
    prepareReview: (async () => {
      const bootstrap = createTestVcsAppBootstrap({
        changesetId: `review-${++instance}`,
        files: [createTestDiffFile({ id: "review.ts", path: "review.ts" })],
      });
      bootstrap.extensions = history.runtime.extensionSession.current;
      return { bootstrap, borrowsExtensions: true };
    }) as never,
    createReviewRuntime: (() => {
      const stop = mock(() => undefined);
      stops.push(stop);
      return { hostClient: undefined, reviewProducer: undefined, stop };
    }) as never,
  };
  const abort = new AbortController();
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      externalQuitSignal={abort.signal}
      onQuit={quit}
      deps={deps}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("History row");

    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("History row");
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("History row");

    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);

    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("quits the session from a standalone review route", async () => {
  const quit = mock(() => undefined);
  const stop = mock(() => undefined);
  const abort = new AbortController();
  const extensionSession = createTestExtensionSession();
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "standalone-review",
    files: [createTestDiffFile({ id: "standalone.ts", path: "standalone.ts" })],
  });
  bootstrap.extensions = extensionSession.current;
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={{
        kind: "review",
        instanceId: 1,
        bootstrap: bootstrap as never,
        runtime: {
          hostClient: undefined,
          reviewProducer: undefined,
          stop,
        } as never,
        extensionSession,
      }}
      externalQuitSignal={abort.signal}
      onQuit={quit}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
  }
});

test("finishes review navigation even when broker shutdown throws", async () => {
  const quit = mock(() => undefined);
  const stop = mock(() => {
    throw new Error("broker close failed");
  });
  const abort = new AbortController();
  const extensionSession = createTestExtensionSession();
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "failing-broker-review",
    files: [createTestDiffFile({ id: "failing.ts", path: "failing.ts" })],
  });
  bootstrap.extensions = extensionSession.current;
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={{
        kind: "review",
        instanceId: 1,
        bootstrap: bootstrap as never,
        runtime: {
          hostClient: undefined,
          reviewProducer: undefined,
          stop,
        } as never,
        extensionSession,
      }}
      externalQuitSignal={abort.signal}
      onQuit={quit}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
  }
});

test("does not start provider planning after shutdown wins the pre-dispatch window", async () => {
  const history = await createHistoryRoute();
  const planReview = mock(history.runtime.planReview);
  history.runtime.planReview = planReview;
  const abort = new AbortController();
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost initialRoute={history} externalQuitSignal={abort.signal} onQuit={quit} />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressEnter();
      abort.abort();
    });
    await settle(setup);
    expect(planReview).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("refuses a nested review that returns independent extension authority", async () => {
  const history = await createHistoryRoute();
  const foreign = createEmptyExtensionLoadResult("/repo");
  const createReviewRuntime = mock(() => {
    throw new Error("nested runtime mounted");
  });
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      externalQuitSignal={new AbortController().signal}
      onQuit={() => undefined}
      deps={{
        prepareReview: (async () => ({
          bootstrap: {
            ...createTestVcsAppBootstrap({
              changesetId: "foreign-review",
              files: [createTestDiffFile({ id: "foreign.ts", path: "foreign.ts" })],
            }),
            extensions: foreign,
          },
          borrowsExtensions: false,
        })) as never,
        createReviewRuntime: createReviewRuntime as never,
      }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("History row");
    expect(setup.captureCharFrame()).toContain("cannot replace");
    expect(createReviewRuntime).not.toHaveBeenCalled();
    expect(foreign.registry.eventBusPhase).toBe("closed");
    expect(history.runtime.extensionSession.closing).toBe(false);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("keeps history mounted when review preparation fails", async () => {
  const history = await createHistoryRoute();
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{
        prepareReview: (async () => {
          throw new Error("provider failed");
        }) as never,
      }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("History row");
    expect(setup.captureCharFrame()).toContain("provider failed");
    expect(quit).not.toHaveBeenCalled();
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("waits for non-cooperative provider planning before menu quit", async () => {
  const history = await createHistoryRoute();
  let resolvePlanning!: (value: { kind: "revision-show"; revisionId: string }) => void;
  const planning = new Promise<{ kind: "revision-show"; revisionId: string }>((resolve) => {
    resolvePlanning = resolve;
  });
  history.runtime.planReview = mock(() => planning);
  const prepareReview = mock(async () => {
    throw new Error("cancelled planning reached preparation");
  });
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{ prepareReview: prepareReview as never }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    await selectHistoryMenuQuit(setup);
    expect(quit).not.toHaveBeenCalled();

    resolvePlanning({ kind: "revision-show", revisionId: "revision-a" });
    await settle(setup);
    expect(prepareReview).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("blocks reopening until dirty-quit cancellation settles", async () => {
  const history = await createHistoryRoute();
  let resolvePlanning!: (value: { kind: "revision-show"; revisionId: string }) => void;
  const planning = new Promise<{ kind: "revision-show"; revisionId: string }>((resolve) => {
    resolvePlanning = resolve;
  });
  history.runtime.planReview = mock(() => planning);
  const prepareReview = mock(async () => {
    throw new Error("cancelled planning reached preparation");
  });
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{ prepareReview: prepareReview as never }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Theme selector");
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("›  github-dark-dimmed");
    await act(async () => setup.mockInput.pressEnter());
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    await selectHistoryMenuQuit(setup);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Save view preferences?");

    await act(async () => setup.mockInput.pressKey("escape"));
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    expect(setup.captureCharFrame()).not.toContain("Save view preferences?");

    resolvePlanning({ kind: "revision-show", revisionId: "revision-a" });
    await settle(setup);
    await act(async () => Bun.sleep(20));
    await setup.renderOnce();
    expect(prepareReview).not.toHaveBeenCalled();
    expect(setup.captureCharFrame()).toContain("History row");
    expect(setup.captureCharFrame()).not.toContain("Preparing review");
    expect(quit).not.toHaveBeenCalled();
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("preserves the original exit status while a saved-preferences quit is delayed", async () => {
  const history = await createHistoryRoute();
  const configHome = mkdtempSync(join(tmpdir(), "hunk-log-delayed-quit-"));
  history.runtime.viewPreferencesConfigPath = join(configHome, "config.toml");
  const quit = mock(() => undefined);
  let scheduledQuit: (() => void) | undefined;
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{
        viewPreferenceQuitScheduler: {
          schedule(callback) {
            scheduledQuit = callback;
            return callback;
          },
          cancel() {},
        },
      }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("q"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Save view preferences?");

    await act(async () => setup.mockInput.typeText("s"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Saved view preferences");
    await act(async () => setup.mockInput.pressKey("c", { ctrl: true }));
    expect(scheduledQuit).toBeDefined();
    await act(async () => scheduledQuit?.());

    expect(quit).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledWith(undefined);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("waits for non-cooperative provider planning after an external signal", async () => {
  const history = await createHistoryRoute();
  let resolvePlanning!: (value: { kind: "revision-show"; revisionId: string }) => void;
  const planning = new Promise<{ kind: "revision-show"; revisionId: string }>((resolve) => {
    resolvePlanning = resolve;
  });
  history.runtime.planReview = mock(() => planning);
  const abort = new AbortController();
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost initialRoute={history} externalQuitSignal={abort.signal} onQuit={quit} />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    act(() => abort.abort());
    expect(quit).not.toHaveBeenCalled();

    resolvePlanning({ kind: "revision-show", revisionId: "revision-a" });
    await settle(setup);
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("defers menu quit until cancelled preparation and retirement settle", async () => {
  const history = await createHistoryRoute();
  const events: string[] = [];
  const quit = mock(() => events.push("quit"));
  let resolvePreparation!: (value: unknown) => void;
  const preparation = new Promise((resolve) => {
    resolvePreparation = resolve;
  });
  history.runtime.extensionSession.trackPrepared = mock(() => undefined);
  history.runtime.extensionSession.retirePrepared = mock(async () => {
    events.push("retire");
  });
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{ prepareReview: (() => preparation) as never }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    await selectHistoryMenuQuit(setup);
    expect(quit).not.toHaveBeenCalled();

    resolvePreparation({
      bootstrap: {
        ...createTestVcsAppBootstrap({
          changesetId: "cancelled-review",
          files: [createTestDiffFile({ id: "cancelled.ts", path: "cancelled.ts" })],
        }),
        extensions: createEmptyExtensionLoadResult("/repo"),
      },
      borrowsExtensions: false,
    });
    await settle(setup);
    expect(events).toEqual(["retire", "quit"]);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("cancels stale preparation, retires its owned registry, and quits once", async () => {
  const history = await createHistoryRoute();
  const events: string[] = [];
  const quit = mock(() => events.push("quit"));
  let resolveRetirement!: () => void;
  const retirement = new Promise<void>((resolve) => {
    resolveRetirement = resolve;
  });
  const retire = mock(async () => {
    events.push("retire-start");
    await retirement;
    events.push("retire-finish");
  });
  let resolvePreparation!: (value: unknown) => void;
  const preparation = new Promise((resolve) => {
    resolvePreparation = resolve;
  });
  const abort = new AbortController();
  history.runtime.extensionSession.trackPrepared = mock(() => undefined);
  history.runtime.extensionSession.retirePrepared = retire as never;
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      externalQuitSignal={abort.signal}
      onQuit={quit}
      deps={{
        prepareReview: (() => preparation) as never,
        createReviewRuntime: mock(() => {
          throw new Error("stale review mounted");
        }) as never,
      }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    act(() => abort.abort());
    expect(quit).not.toHaveBeenCalled();
    resolvePreparation({
      bootstrap: {
        ...createTestVcsAppBootstrap({
          changesetId: "stale-review",
          files: [createTestDiffFile({ id: "stale.ts", path: "stale.ts" })],
        }),
        extensions: createEmptyExtensionLoadResult("/repo"),
      },
      borrowsExtensions: false,
    });
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    resolveRetirement();
    await settle(setup);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["retire-start", "retire-finish", "quit"]);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});
