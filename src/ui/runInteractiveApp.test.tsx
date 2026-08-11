import { describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import type { ReviewSessionRuntime } from "../app/reviewSessionRuntime";
import type { HunkSessionBrokerClient } from "../session/types";
import { runInteractiveApp, type InteractiveAppRuntimeDeps } from "./runInteractiveApp";

/** Build the minimum authority passed through to the mounted AppHost element. */
function createInput() {
  const bootstrap = createTestVcsAppBootstrap({ files: [createTestDiffFile()] });
  return {
    bootstrap,
    rawInput: bootstrap.input,
    controllingTerminal: null,
    runtime: {} as ReviewSessionRuntime,
  };
}

/** Cast narrow lifecycle fakes to OpenTUI's implementation signatures. */
function createDeps(overrides: Partial<InteractiveAppRuntimeDeps> = {}) {
  const renderer = { destroy: mock(() => undefined) };
  const root = {
    render: mock((_node: unknown) => undefined),
    unmount: mock(() => undefined),
  };
  const deps: InteractiveAppRuntimeDeps = {
    createCliRendererImpl: (async () => renderer) as never,
    createRootImpl: (() => root) as never,
    installJobControlInterruptSupportImpl: (() => ({ dispose: mock(() => undefined) })) as never,
    installJobControlSuspendSupportImpl: (() => ({ dispose: mock(() => undefined) })) as never,
    shutdownSessionImpl: mock(() => undefined) as never,
    onSignalImpl: () => undefined,
    offSignalImpl: () => undefined,
    ...overrides,
  };
  return { deps, renderer, root };
}

describe("runInteractiveApp lifecycle", () => {
  test("propagates renderer creation failure without installing or invoking later owners", async () => {
    const failure = new Error("renderer failed");
    const createRootImpl = mock(() => {
      throw new Error("unreachable");
    });
    const installInterrupt = mock(() => ({ dispose: mock(() => undefined) }));
    const installSuspend = mock(() => ({ dispose: mock(() => undefined) }));
    const onSignal = mock(() => undefined);
    const offSignal = mock(() => undefined);
    const shutdown = mock(() => undefined);
    const hostStop = mock(() => undefined);
    const { deps } = createDeps({
      createCliRendererImpl: (async () => {
        throw failure;
      }) as never,
      createRootImpl: createRootImpl as never,
      installJobControlInterruptSupportImpl: installInterrupt as never,
      installJobControlSuspendSupportImpl: installSuspend as never,
      onSignalImpl: onSignal,
      offSignalImpl: offSignal,
      shutdownSessionImpl: shutdown as never,
    });

    await expect(
      runInteractiveApp(
        { ...createInput(), hostClient: { stop: hostStop } as unknown as HunkSessionBrokerClient },
        deps,
      ),
    ).rejects.toBe(failure);
    expect(createRootImpl).not.toHaveBeenCalled();
    expect(installInterrupt).not.toHaveBeenCalled();
    expect(installSuspend).not.toHaveBeenCalled();
    expect(onSignal).not.toHaveBeenCalled();
    expect(offSignal).not.toHaveBeenCalled();
    expect(hostStop).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  test("attempts renderer destruction once without replacing a root creation failure", async () => {
    const failure = new Error("root failed");
    const { deps, renderer } = createDeps({
      createRootImpl: (() => {
        throw failure;
      }) as never,
    });
    renderer.destroy.mockImplementation(() => {
      throw new Error("destroy failed");
    });

    await expect(runInteractiveApp(createInput(), deps)).rejects.toBe(failure);
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  test("cleans every installed owner once when render fails", async () => {
    const failure = new Error("render failed");
    const interruptDispose = mock(() => undefined);
    const suspendDispose = mock(() => undefined);
    const hostStop = mock(() => undefined);
    const hostClient = { stop: hostStop } as unknown as HunkSessionBrokerClient;
    const offSignalImpl = mock(() => undefined);
    const { deps, renderer, root } = createDeps({
      installJobControlInterruptSupportImpl: (() => ({ dispose: interruptDispose })) as never,
      installJobControlSuspendSupportImpl: (() => ({ dispose: suspendDispose })) as never,
      offSignalImpl,
    });
    root.render.mockImplementation(() => {
      throw failure;
    });

    await expect(runInteractiveApp({ ...createInput(), hostClient }, deps)).rejects.toBe(failure);
    expect(offSignalImpl).toHaveBeenCalledTimes(2);
    expect(interruptDispose).toHaveBeenCalledTimes(1);
    expect(suspendDispose).toHaveBeenCalledTimes(1);
    expect(hostStop).toHaveBeenCalledTimes(1);
    expect(root.unmount).toHaveBeenCalledTimes(1);
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  test("preserves render failure while attempting every throwing cleanup owner", async () => {
    const failure = new Error("render failed");
    const offSignal = mock(() => {
      throw new Error("off failed");
    });
    const interruptDispose = mock(() => {
      throw new Error("interrupt failed");
    });
    const suspendDispose = mock(() => {
      throw new Error("suspend failed");
    });
    const hostStop = mock(() => {
      throw new Error("host failed");
    });
    const { deps, renderer, root } = createDeps({
      offSignalImpl: offSignal,
      installJobControlInterruptSupportImpl: (() => ({ dispose: interruptDispose })) as never,
      installJobControlSuspendSupportImpl: (() => ({ dispose: suspendDispose })) as never,
    });
    root.render.mockImplementation(() => {
      throw failure;
    });
    root.unmount.mockImplementation(() => {
      throw new Error("unmount failed");
    });
    renderer.destroy.mockImplementation(() => {
      throw new Error("destroy failed");
    });

    await expect(
      runInteractiveApp(
        { ...createInput(), hostClient: { stop: hostStop } as unknown as HunkSessionBrokerClient },
        deps,
      ),
    ).rejects.toBe(failure);
    expect(offSignal).toHaveBeenCalledTimes(2);
    expect(interruptDispose).toHaveBeenCalledTimes(1);
    expect(suspendDispose).toHaveBeenCalledTimes(1);
    expect(hostStop).toHaveBeenCalledTimes(1);
    expect(root.unmount).toHaveBeenCalledTimes(1);
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  test("makes SIGINT, SIGTERM, and AppHost onQuit share one idempotent shutdown", async () => {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const onSignalImpl = mock((signal: NodeJS.Signals, listener: () => void) => {
      handlers.set(signal, listener);
    });
    const offSignalImpl = mock((signal: NodeJS.Signals) => handlers.delete(signal));
    const shutdownSessionImpl = mock(() => undefined);
    const hostStop = mock(() => undefined);
    let mounted: ReactElement<{ onQuit: () => void }> | undefined;
    const { deps, root } = createDeps({
      onSignalImpl,
      offSignalImpl,
      shutdownSessionImpl: shutdownSessionImpl as never,
    });
    root.render.mockImplementation((node: unknown) => {
      mounted = node as ReactElement<{ onQuit: () => void }>;
    });

    await runInteractiveApp(
      { ...createInput(), hostClient: { stop: hostStop } as unknown as HunkSessionBrokerClient },
      deps,
    );
    expect(onSignalImpl).toHaveBeenCalledTimes(2);
    handlers.get("SIGINT")!();
    handlers.get("SIGTERM")?.();
    mounted!.props.onQuit();

    expect(shutdownSessionImpl).toHaveBeenCalledTimes(1);
    expect(hostStop).toHaveBeenCalledTimes(1);
    expect(offSignalImpl).toHaveBeenCalledTimes(2);
  });

  test("normal shutdown remains idempotent when earlier cleanup throws", async () => {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const shutdownSessionImpl = mock(() => undefined);
    const hostStop = mock(() => undefined);
    let mounted: ReactElement<{ onQuit: () => void }> | undefined;
    const { deps, root } = createDeps({
      onSignalImpl: (signal, listener) => handlers.set(signal, listener),
      offSignalImpl: () => {
        throw new Error("off failed");
      },
      shutdownSessionImpl: shutdownSessionImpl as never,
    });
    root.render.mockImplementation((node: unknown) => {
      mounted = node as ReactElement<{ onQuit: () => void }>;
    });

    await runInteractiveApp(
      { ...createInput(), hostClient: { stop: hostStop } as unknown as HunkSessionBrokerClient },
      deps,
    );
    expect(() => handlers.get("SIGINT")!()).toThrow("off failed");
    expect(() => mounted!.props.onQuit()).not.toThrow();
    expect(hostStop).toHaveBeenCalledTimes(1);
    expect(shutdownSessionImpl).toHaveBeenCalledTimes(1);
  });
});
