import { describe, expect, mock, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import type { createRoot } from "@opentui/react";
import { runHunkSession, type HunkSessionRunnerDeps } from "./runHunkSession";

/** Build injected renderer/root dependencies without starting a terminal. */
function createTestDeps(events: string[]) {
  const renderer = {
    isDestroyed: false,
    keyInput: { on: mock(() => undefined), off: mock(() => undefined) },
    suspend: mock(() => undefined),
    resume: mock(() => undefined),
    destroy: mock(() => events.push("destroy")),
  } as unknown as CliRenderer;
  const root = {
    render: mock(() => events.push("render")),
    unmount: mock(() => events.push("unmount")),
  } as unknown as ReturnType<typeof createRoot>;
  const support = (name: string) => ({ dispose: () => events.push(name) });
  const deps: HunkSessionRunnerDeps = {
    createRenderer: (async () => renderer) as never,
    createReactRoot: (() => root) as never,
    installInterrupt: (() => support("interrupt")) as never,
    installSuspend: (() => support("suspend")) as never,
    installDisconnect: (() => support("disconnect")) as never,
    disposeWorker: () => events.push("worker"),
    onSignal: () => undefined,
    offSignal: () => undefined,
  };
  return { deps, renderer, root };
}

const stdin = { isTTY: true } as unknown as NodeJS.ReadStream & {
  on: never;
  off: never;
};
const stdout = {} as NodeJS.WriteStream;

describe("runHunkSession", () => {
  test("waits for host completion and tears down every process resource once", async () => {
    const events: string[] = [];
    const { deps } = createTestDeps(events);
    let finish: ((exitCode?: number) => void) | undefined;
    const running = runHunkSession(
      {
        stdin,
        stdout,
        useMouse: true,
        signals: ["SIGTERM"],
        beforeTeardown: async () => {
          events.push("cleanup-start");
          await Promise.resolve();
          events.push("cleanup-finish");
        },
        render: (context) => {
          finish = context.finish;
          return null;
        },
      },
      deps,
    );
    await Promise.resolve();
    expect(events).toEqual(["render"]);

    finish?.(7);
    finish?.(9);
    expect(await running).toBe(7);
    expect(events).toEqual([
      "render",
      "cleanup-start",
      "cleanup-finish",
      "interrupt",
      "suspend",
      "disconnect",
      "worker",
      "unmount",
      "destroy",
    ]);
  });

  test("requests graceful completion on a signal without tearing down early", async () => {
    const events: string[] = [];
    const { deps } = createTestDeps(events);
    let signalHandler: (() => void) | undefined;
    deps.onSignal = (_signal, listener) => {
      signalHandler = listener;
    };
    let finish: (() => void) | undefined;
    let quitSignal: AbortSignal | undefined;
    const running = runHunkSession(
      {
        stdin,
        stdout,
        useMouse: true,
        signals: ["SIGTERM"],
        signalExitCode: () => 143,
        render: (context) => {
          finish = context.finish;
          quitSignal = context.externalQuitSignal;
          return null;
        },
      },
      deps,
    );
    await Promise.resolve();

    signalHandler?.();
    expect(quitSignal?.aborted).toBe(true);
    expect(events).toEqual(["render"]);
    finish?.();
    expect(await running).toBe(143);
  });

  test("still tears down the terminal when awaited session cleanup fails", async () => {
    const events: string[] = [];
    const { deps } = createTestDeps(events);
    let finish: (() => void) | undefined;
    const running = runHunkSession(
      {
        stdin,
        stdout,
        useMouse: true,
        signals: [],
        beforeTeardown: async () => {
          events.push("cleanup");
          throw new Error("cleanup failed");
        },
        render: (context) => {
          finish = context.finish;
          return null;
        },
      },
      deps,
    );
    await Promise.resolve();
    finish?.();

    await expect(running).rejects.toThrow("cleanup failed");
    expect(events).toEqual([
      "render",
      "cleanup",
      "interrupt",
      "suspend",
      "disconnect",
      "worker",
      "unmount",
      "destroy",
    ]);
  });

  test("isolates disposer and unmount failures so renderer cleanup still completes", async () => {
    const events: string[] = [];
    const { deps, renderer, root } = createTestDeps(events);
    deps.installInterrupt = (() => ({
      dispose() {
        events.push("interrupt");
        throw new Error("interrupt failed");
      },
    })) as never;
    root.unmount = mock(() => {
      events.push("unmount");
      throw new Error("unmount failed");
    });
    renderer.destroy = mock(() => {
      events.push("destroy");
      throw new Error("destroy failed");
    });
    const rendererDestroyed = mock(() => events.push("renderer-callback"));
    let finish: (() => void) | undefined;
    const running = runHunkSession(
      {
        stdin,
        stdout,
        useMouse: true,
        signals: [],
        onRendererDestroy: rendererDestroyed,
        render(context) {
          finish = context.finish;
          return null;
        },
      },
      deps,
    );
    await Promise.resolve();
    finish?.();

    await expect(running).rejects.toThrow("interrupt failed");
    expect(events).toEqual([
      "render",
      "interrupt",
      "suspend",
      "disconnect",
      "worker",
      "unmount",
      "destroy",
      "renderer-callback",
    ]);
    expect(rendererDestroyed).toHaveBeenCalledTimes(1);
  });

  test("runs failure ownership cleanup before attempting terminal teardown", async () => {
    const events: string[] = [];
    const { deps, root } = createTestDeps(events);
    root.render = mock(() => {
      events.push("render");
      throw new Error("render failed");
    });

    await expect(
      runHunkSession(
        {
          stdin,
          stdout,
          useMouse: false,
          signals: [],
          onFailure: async () => {
            events.push("failure-start");
            await Promise.resolve();
            events.push("failure-finish");
          },
          render: () => null,
        },
        deps,
      ),
    ).rejects.toThrow("render failed");
    expect(events).toEqual([
      "render",
      "failure-start",
      "failure-finish",
      "interrupt",
      "suspend",
      "disconnect",
      "worker",
      "unmount",
      "destroy",
    ]);
  });

  test("destroys a renderer when root creation fails", async () => {
    const events: string[] = [];
    const { deps } = createTestDeps(events);
    deps.createReactRoot = (() => {
      throw new Error("root failed");
    }) as never;

    await expect(
      runHunkSession(
        {
          stdin,
          stdout,
          useMouse: false,
          signals: [],
          render: () => null,
        },
        deps,
      ),
    ).rejects.toThrow("root failed");
    expect(events).toEqual(["worker", "destroy"]);
  });

  test("disposes process-lifetime state when renderer creation fails", async () => {
    const events: string[] = [];
    const { deps } = createTestDeps(events);
    deps.createRenderer = (async () => {
      throw new Error("renderer failed");
    }) as never;

    await expect(
      runHunkSession(
        {
          stdin,
          stdout,
          useMouse: false,
          signals: [],
          render: () => null,
        },
        deps,
      ),
    ).rejects.toThrow("renderer failed");
    expect(events).toEqual(["worker"]);
  });
});
