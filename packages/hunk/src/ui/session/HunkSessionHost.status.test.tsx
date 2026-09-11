import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestStatusRuntime } from "../../../../../test/helpers/status-runtime";
import type { AppBootstrap } from "../../core/bootstrap";
import { StatusController } from "../status/controller";
import { HunkSessionHost } from "./HunkSessionHost";
import { availableThemes } from "../themes";

/** Flush route preparation and the existing review commit/quit lifecycle. */
async function settleStatusTest(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await Bun.sleep(30);
    await setup.renderOnce();
    await Bun.sleep(30);
    await setup.renderOnce();
  });
}

/** Mount the actual three-surface host while substituting only broker process resources. */
async function createTestStatusHost(runtime = createTestStatusRuntime()) {
  const controller = new StatusController(runtime);
  const abort = new AbortController();
  const quit = mock(() => undefined);
  const mounted: {
    bootstrap: AppBootstrap;
    cwd: string | undefined;
    stop: ReturnType<typeof mock>;
  }[] = [];
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={{ kind: "status", runtime, controller }}
      initialization={runtime.initialization}
      externalQuitSignal={abort.signal}
      onQuit={quit}
      deps={{
        createReviewRuntime: ((bootstrap: AppBootstrap, cwd?: string) => {
          const stop = mock(() => undefined);
          mounted.push({ bootstrap, cwd, stop });
          return { stop, hostClient: undefined, reviewProducer: undefined };
        }) as never,
      }}
    />,
    { width: 120, height: 24 },
  );
  await settleStatusTest(setup);
  return {
    setup,
    controller,
    abort,
    quit,
    mounted,
    async close() {
      setup.renderer.destroy();
      await controller.close();
      await runtime.extensionSession.shutdown();
    },
  };
}

test("status -> full diff -> status retains selection, then log -> diff -> log -> status", async () => {
  const runtime = createTestStatusRuntime();
  const host = await createTestStatusHost(runtime);
  const { setup, mounted, controller } = host;
  try {
    expect(setup.captureCharFrame()).toContain("alpha.ts  modified (staged) · modified (unstaged)");
    await act(async () => setup.mockInput.pressArrow("down"));
    expect(controller.getSnapshot().selected).toBe("path:beta.ts");
    await act(async () => setup.mockInput.pressEnter());
    await settleStatusTest(setup);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.bootstrap.changeset.files.map((file) => file.path)).toEqual([
      "alpha.ts",
      "beta.ts",
    ]);
    expect(mounted[0]!.cwd).toBe(runtime.snapshot.worktree.path);
    expect(mounted[0]!.bootstrap.extensions).toBe(runtime.extensionSession.current);
    await act(async () => setup.mockInput.pressKey("q"));
    await settleStatusTest(setup);
    expect(mounted[0]!.stop).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().selected).toBe("path:beta.ts");
    expect(setup.captureCharFrame()).toContain("Other worktrees");
    await act(async () => setup.mockInput.pressKey("l"));
    await settleStatusTest(setup);
    expect(setup.captureCharFrame()).toContain("Status history commit");
    await act(async () => setup.mockInput.pressEnter());
    await settleStatusTest(setup);
    expect(mounted).toHaveLength(2);
    await act(async () => setup.mockInput.pressKey("q"));
    await settleStatusTest(setup);
    expect(setup.captureCharFrame()).toContain("Status history commit");
    await act(async () => setup.mockInput.pressKey("q"));
    await settleStatusTest(setup);
    expect(setup.captureCharFrame()).toContain("Other worktrees");
    expect(host.quit).not.toHaveBeenCalled();
  } finally {
    await host.close();
  }
});

test("custom theme and review preferences seed subsequent reviews in both route directions", async () => {
  const runtime = createTestStatusRuntime();
  const host = await createTestStatusHost(runtime);
  const { setup, mounted } = host;
  try {
    await act(async () => setup.mockInput.pressKey("t"));
    await setup.renderOnce();
    const index = availableThemes().findIndex((theme) => theme.id === "nord");
    await act(async () => {
      for (let i = 0; i <= index; i++) setup.mockInput.pressArrow("up");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Status custom");
    await act(async () => setup.mockInput.pressEnter());
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressKey("u"));
    await settleStatusTest(setup);
    expect(mounted[0]!.bootstrap.initialTheme).toBe("status-custom");
    await act(async () => setup.mockInput.pressKey("l"));
    await act(async () => setup.mockInput.pressKey("w"));
    await act(async () => setup.mockInput.pressKey("q"));
    await settleStatusTest(setup);
    await act(async () => setup.mockInput.pressKey("l"));
    await settleStatusTest(setup);
    await act(async () => setup.mockInput.pressEnter());
    await settleStatusTest(setup);
    expect(mounted[1]!.bootstrap.initialTheme).toBe("status-custom");
    expect(mounted[1]!.bootstrap.initialShowLineNumbers).toBe(false);
    expect(mounted[1]!.bootstrap.initialWrapLines).toBe(!runtime.initialViewPreferences.wrapLines);
    expect(mounted[1]!.bootstrap.input.options.experimental).toBe(true);
    expect(mounted[1]!.bootstrap.customThemes).toEqual(runtime.initialization.theme.customThemes);
  } finally {
    await host.close();
  }
});

test("sibling inspection and back retain launch authority while reviews target the sibling", async () => {
  const runtime = createTestStatusRuntime();
  const owner = runtime.extensionSession.current;
  const host = await createTestStatusHost(runtime);
  try {
    await act(async () => {
      host.setup.mockInput.pressArrow("down");
      host.setup.mockInput.pressArrow("down");
    });
    await act(async () => host.setup.mockInput.pressEnter());
    await settleStatusTest(host.setup);
    expect(host.controller.getSnapshot().snapshot.worktree.id).toBe("sibling");
    const target = host.controller.getSnapshot().snapshot.worktree.path;
    await act(async () => host.setup.mockInput.pressKey("s"));
    await settleStatusTest(host.setup);
    expect(host.mounted[0]!.cwd).toBe(target);
    expect(host.mounted[0]!.bootstrap.extensions).toBe(owner);
    await act(async () => host.setup.mockInput.pressKey("q"));
    await settleStatusTest(host.setup);
    expect(host.controller.getSnapshot().snapshot.worktree.path).toBe(target);
    await act(async () => host.setup.mockInput.pressKey("q"));
    await settleStatusTest(host.setup);
    expect(host.controller.getSnapshot().snapshot.worktree.path).toBe(
      runtime.snapshot.worktree.path,
    );
    expect(host.quit).not.toHaveBeenCalled();
  } finally {
    await host.close();
  }
});

test("cancelled/late status preparation never mounts a runtime and global shutdown ends the session", async () => {
  const runtime = createTestStatusRuntime();
  let resolve!: (value: Awaited<ReturnType<typeof runtime.prepareReview>>) => void;
  const original = runtime.prepareReview;
  let signal: AbortSignal | undefined;
  runtime.prepareReview = mock((_input, _cwd, active) => {
    signal = active;
    return new Promise<Awaited<ReturnType<typeof original>>>((done) => {
      resolve = done;
    });
  });
  const host = await createTestStatusHost(runtime);
  try {
    await act(async () => {
      host.setup.mockInput.pressKey("s");
      host.setup.mockInput.pressKey("s");
    });
    await settleStatusTest(host.setup);
    expect(runtime.prepareReview).toHaveBeenCalledTimes(1);
    await act(async () => host.abort.abort());
    expect(signal?.aborted).toBe(true);
    expect(host.quit).not.toHaveBeenCalled();
    await act(async () =>
      resolve(
        await original({ kind: "vcs", staged: true, options: {} }, runtime.snapshot.worktree.path),
      ),
    );
    await settleStatusTest(host.setup);
    expect(host.mounted).toHaveLength(0);
    expect(host.quit).toHaveBeenCalledTimes(1);
  } finally {
    await host.close();
  }
});

test("failed status preparation leaves the caller usable and a later open succeeds", async () => {
  const runtime = createTestStatusRuntime();
  const original = runtime.planReview;
  runtime.planReview = async () => {
    throw new Error("Workspace changed; refresh");
  };
  const host = await createTestStatusHost(runtime);
  try {
    await act(async () => host.setup.mockInput.pressKey("s"));
    await settleStatusTest(host.setup);
    expect(host.mounted).toHaveLength(0);
    expect(host.setup.captureCharFrame()).toContain("Workspace changed; refresh");
    expect(host.setup.captureCharFrame()).toContain("Other worktrees");
    runtime.planReview = original;
    await act(async () => host.setup.mockInput.pressKey("s"));
    await settleStatusTest(host.setup);
    expect(host.mounted).toHaveLength(1);
  } finally {
    await host.close();
  }
});

test("global shutdown cancels the first history page before log mounts and closes its source", async () => {
  const runtime = createTestStatusRuntime();
  const openHistory = runtime.openHistory;
  const sourceClosed = mock(() => undefined);
  let readSignal: AbortSignal | undefined;
  runtime.openHistory = async (path) => {
    const history = await openHistory(path);
    history.source.read = ({ signal }) => {
      readSignal = signal;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else
          signal?.addEventListener("abort", () => resolve({ commits: [], done: true }), {
            once: true,
          });
      });
    };
    history.close = async () => {
      sourceClosed();
    };
    return history;
  };
  const host = await createTestStatusHost(runtime);
  try {
    await act(async () => host.setup.mockInput.pressKey("l"));
    await settleStatusTest(host.setup);
    expect(readSignal).toBeDefined();
    await act(async () => host.abort.abort());
    await settleStatusTest(host.setup);
    expect(readSignal!.aborted).toBe(true);
    expect(sourceClosed).toHaveBeenCalledTimes(1);
    expect(host.quit).toHaveBeenCalledTimes(1);
    expect(host.mounted).toHaveLength(0);
  } finally {
    await host.close();
  }
});

test("detected light theme persists and only root status asks to save changed preferences", async () => {
  const runtime = createTestStatusRuntime();
  runtime.initialization.theme.initialTheme = "auto";
  runtime.initialization.theme.initialThemeMode = "light";
  runtime.promptSaveViewPreferences = true;
  const host = await createTestStatusHost(runtime);
  try {
    await act(async () => host.setup.mockInput.pressKey("u"));
    await settleStatusTest(host.setup);
    expect(host.mounted[0]!.bootstrap.initialTheme).toBe("github-light-default");
    await act(async () => host.setup.mockInput.pressKey("l"));
    await act(async () => host.setup.mockInput.pressKey("q"));
    await settleStatusTest(host.setup);
    expect(host.setup.captureCharFrame()).not.toContain("Save view preferences?");
    await act(async () => host.setup.mockInput.pressKey("l"));
    await settleStatusTest(host.setup);
    await act(async () => host.setup.mockInput.pressKey("q"));
    await settleStatusTest(host.setup);
    expect(host.setup.captureCharFrame()).not.toContain("Save view preferences?");
    await act(async () => host.setup.mockInput.pressKey("q"));
    await settleStatusTest(host.setup);
    expect(host.setup.captureCharFrame()).toContain("Save view preferences?");
    expect(host.quit).not.toHaveBeenCalled();
  } finally {
    await host.close();
  }
});

test("explicit untracked row overrides launch exclusion only for its full comparison", async () => {
  const runtime = createTestStatusRuntime();
  runtime.launchOptions.excludeUntracked = true;
  runtime.snapshot.paths[1]!.worktree = "untracked";
  const host = await createTestStatusHost(runtime);
  try {
    await act(async () => host.setup.mockInput.pressArrow("down"));
    await act(async () => host.setup.mockInput.pressEnter());
    await settleStatusTest(host.setup);
    expect(host.mounted[0]!.bootstrap.input.options.excludeUntracked).toBe(false);
    expect(host.mounted[0]!.bootstrap.changeset.files).toHaveLength(2);
    await act(async () => host.setup.mockInput.pressKey("q"));
    await settleStatusTest(host.setup);
    await act(async () => host.setup.mockInput.pressKey("u"));
    await settleStatusTest(host.setup);
    expect(host.mounted[1]!.bootstrap.input.options.excludeUntracked).toBe(true);
    expect(runtime.launchOptions.excludeUntracked).toBe(true);
  } finally {
    await host.close();
  }
});

for (const global of [false, true]) {
  test(`rejecting history cleanup settles ${global ? "global shutdown" : "local cancellation"} exactly once`, async () => {
    const runtime = createTestStatusRuntime();
    const openHistory = runtime.openHistory;
    const closed = mock(() => {
      throw new Error("provider close rejected");
    });
    runtime.openHistory = async (path) => {
      const history = await openHistory(path);
      history.source.read = ({ signal }) =>
        new Promise((resolve) => {
          signal!.addEventListener("abort", () => resolve({ commits: [], done: true }), {
            once: true,
          });
        });
      history.close = async () => {
        closed();
      };
      return history;
    };
    const host = await createTestStatusHost(runtime);
    try {
      await act(async () => host.setup.mockInput.pressKey("l"));
      await settleStatusTest(host.setup);
      await act(async () => {
        if (global) host.abort.abort();
        else host.setup.mockInput.pressKey("q");
      });
      await settleStatusTest(host.setup);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(host.mounted).toHaveLength(0);
      expect(host.controller.getSnapshot().notice).toContain("provider close rejected");
      if (global) expect(host.quit).toHaveBeenCalledTimes(1);
      else {
        expect(host.quit).not.toHaveBeenCalled();
        expect(host.setup.captureCharFrame()).not.toContain("Preparing…");
        await act(async () => host.setup.mockInput.pressKey("u"));
        await settleStatusTest(host.setup);
        expect(host.mounted).toHaveLength(1);
        await act(async () => host.setup.mockInput.pressKey("q"));
        await settleStatusTest(host.setup);
        await act(async () => host.setup.mockInput.pressKey("q"));
        await settleStatusTest(host.setup);
        expect(host.quit).toHaveBeenCalledTimes(1);
      }
    } finally {
      await host.close();
    }
  });
}

for (const transparent of [false, true]) {
  test(`resolved transparency ${transparent} survives status/log/review returns and theme changes`, async () => {
    const runtime = createTestStatusRuntime();
    runtime.launchOptions.transparentBackground = transparent;
    const host = await createTestStatusHost(runtime);
    // Inspect actual mounted surface paint, not only propagated bootstrap options.
    const backgroundAlpha = () =>
      (host.setup.renderer.root.getChildren()[0] as import("@opentui/core").BoxRenderable)
        .backgroundColor.a;
    try {
      expect(backgroundAlpha()).toBe(transparent ? 0 : 1);
      await act(async () => host.setup.mockInput.pressKey("u"));
      await settleStatusTest(host.setup);
      expect(host.mounted[0]!.bootstrap.input.options.transparentBackground).toBe(transparent);
      expect(backgroundAlpha()).toBe(transparent ? 0 : 1);
      await act(async () => host.setup.mockInput.pressKey("q"));
      await settleStatusTest(host.setup);
      expect(backgroundAlpha()).toBe(transparent ? 0 : 1);
      await act(async () => host.setup.mockInput.pressKey("l"));
      await settleStatusTest(host.setup);
      expect(backgroundAlpha()).toBe(transparent ? 0 : 1);
      await act(async () => host.setup.mockInput.pressKey("t"));
      await act(async () => host.setup.mockInput.pressArrow("down"));
      await act(async () => host.setup.mockInput.pressEnter());
      await settleStatusTest(host.setup);
      expect(backgroundAlpha()).toBe(transparent ? 0 : 1);
      await act(async () => host.setup.mockInput.pressEnter());
      await settleStatusTest(host.setup);
      expect(backgroundAlpha()).toBe(transparent ? 0 : 1);
      await act(async () => host.setup.mockInput.pressKey("q"));
      await settleStatusTest(host.setup);
      await act(async () => host.setup.mockInput.pressKey("q"));
      await settleStatusTest(host.setup);
      expect(backgroundAlpha()).toBe(transparent ? 0 : 1);
    } finally {
      await host.close();
    }
  });
}

for (const exit of ["local", "global-race", "unmount"] as const) {
  test(`mounted non-EOF Log handles rejecting cleanup on ${exit} without stranding its caller`, async () => {
    const runtime = createTestStatusRuntime();
    const openHistory = runtime.openHistory;
    const runtimeClose = runtime.close;
    runtime.close = mock(runtimeClose);
    let rejectClose: ((error: Error) => void) | undefined;
    const closed = mock(async () => {
      if (exit === "global-race")
        await new Promise<void>((_resolve, reject) => {
          rejectClose = reject;
        });
      else throw new Error("mounted source close rejected");
    });
    runtime.openHistory = async (path) => {
      const history = await openHistory(path);
      const first = await history.source.read({ limit: 10 });
      let read = false;
      history.source.read = async ({ signal }) => {
        if (!read) {
          read = true;
          return { ...first, done: false };
        }
        return new Promise((resolve) => {
          if (signal?.aborted) resolve({ commits: [], done: false });
          else
            signal?.addEventListener("abort", () => resolve({ commits: [], done: false }), {
              once: true,
            });
        });
      };
      history.close = closed;
      return history;
    };
    const host = await createTestStatusHost(runtime);
    try {
      await act(async () => host.setup.mockInput.pressKey("l"));
      await settleStatusTest(host.setup);
      expect(host.setup.captureCharFrame()).toContain("Status history commit");
      if (exit === "unmount") {
        await act(async () => {
          host.setup.renderer.destroy();
          await Bun.sleep(0);
        });
      } else {
        await act(async () => host.setup.mockInput.pressKey("q"));
        await settleStatusTest(host.setup);
        if (exit === "global-race") {
          expect(closed).toHaveBeenCalledTimes(1);
          await act(async () => host.abort.abort());
          await settleStatusTest(host.setup);
          expect(host.quit).not.toHaveBeenCalled();
          await act(async () => rejectClose!(new Error("mounted source close rejected")));
          await settleStatusTest(host.setup);
          expect(host.quit).toHaveBeenCalledTimes(1);
          expect(runtime.close).toHaveBeenCalledTimes(1);
        } else {
          expect(host.setup.captureCharFrame()).toContain("Other worktrees");
          expect(host.quit).not.toHaveBeenCalled();
          await act(async () => host.setup.mockInput.pressKey("u"));
          await settleStatusTest(host.setup);
          expect(host.mounted).toHaveLength(1);
        }
      }
      expect(closed).toHaveBeenCalledTimes(1);
      expect(host.controller.getSnapshot().notice).toContain("mounted source close rejected");
    } finally {
      await host.close();
    }
    expect(closed).toHaveBeenCalledTimes(1);
  });
}

test("transparent monochrome status keeps menu and dialog backings opaque", async () => {
  const runtime = createTestStatusRuntime();
  runtime.launchOptions.transparentBackground = true;
  runtime.input.color = "never";
  const host = await createTestStatusHost(runtime);
  try {
    const surface =
      host.setup.renderer.root.getChildren()[0] as import("@opentui/core").BoxRenderable;
    expect(surface.backgroundColor.a).toBe(0);
    for (const key of ["F10", "t"]) {
      await act(async () => host.setup.mockInput.pressKey(key));
      await settleStatusTest(host.setup);
      // The dropdown and framed modal are direct absolute children, above the transparent surface.
      const backing = surface
        .getChildren()
        .find(
          (child) => child.zIndex === (key === "F10" ? 40 : 60),
        ) as import("@opentui/core").BoxRenderable;
      expect(backing).toBeDefined();
      expect(backing.backgroundColor.a).toBe(1);
      expect(surface.backgroundColor.a).toBe(0);
      await act(async () => host.setup.mockInput.pressEscape());
      await settleStatusTest(host.setup);
    }
  } finally {
    await host.close();
  }
});

test("group Enter/Space activation stays local, hidden paths cannot open, and child routes retain expansion", async () => {
  const runtime = createTestStatusRuntime();
  runtime.snapshot.paths = Array.from({ length: 11 }, (_, i) => ({
    path: `file-${i}.ts`,
    index: "unchanged",
    worktree: "modified",
    conflict: false,
  }));
  const host = await createTestStatusHost(runtime);
  const { setup, controller, mounted } = host;
  try {
    await act(async () => controller.select("toggle:tracked"));
    await act(async () => setup.mockInput.pressEnter());
    expect(controller.getSnapshot().expandedPathGroups.tracked).toBe(true);
    expect(controller.getSnapshot().selected).toBe("toggle:tracked");
    expect(mounted).toHaveLength(0);
    await settleStatusTest(setup);
    expect(setup.captureCharFrame()).toContain("Show fewer");
    await act(async () => setup.mockInput.pressKey(" "));
    expect(controller.getSnapshot().expandedPathGroups.tracked).toBe(false);
    expect(mounted).toHaveLength(0);
    await act(async () => {
      controller.select("path:file-10.ts");
      setup.mockInput.pressEnter();
    });
    expect(mounted).toHaveLength(0);
    await act(async () => controller.togglePathGroup("tracked"));
    await act(async () => setup.mockInput.pressKey("l"));
    await settleStatusTest(setup);
    expect(setup.captureCharFrame()).toContain("Status history commit");
    await act(async () => setup.mockInput.pressKey("q"));
    await settleStatusTest(setup);
    expect(controller.getSnapshot().expandedPathGroups).toEqual({
      tracked: true,
      untracked: false,
    });
    expect(setup.captureCharFrame()).toContain("Show fewer");
  } finally {
    await host.close();
  }
});
