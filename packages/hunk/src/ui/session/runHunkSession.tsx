import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import {
  installJobControlInterruptSupport,
  installJobControlSuspendSupport,
  type JobControlInterruptSupport,
  type JobControlSuspendSupport,
} from "../../core/process/jobControl";
import {
  installTerminalDisconnectSupport,
  type TerminalDisconnectSupport,
  type TerminalInputEvents,
} from "../../core/process/terminal";
import { disposeHighlightWorker } from "../diff/worker";

type Renderer = Awaited<ReturnType<typeof createCliRenderer>>;
type Root = ReturnType<typeof createRoot>;
type SignalListener = () => void;

export interface HunkSessionRenderContext {
  externalQuitSignal: AbortSignal;
  finish(exitCode?: number): void;
}

export interface HunkSessionRunnerOptions {
  stdin: NodeJS.ReadStream & TerminalInputEvents;
  stdout: NodeJS.WriteStream;
  useMouse: boolean;
  signals: readonly NodeJS.Signals[];
  /** Preserve the entry surface's exit status when an OS signal asks it to quit. */
  signalExitCode?: (signal: NodeJS.Signals) => number | undefined;
  /** Preserve the entry surface's exit status when raw-mode Ctrl-C asks it to quit. */
  interruptExitCode?: number;
  onRendererDestroy?: () => void;
  /** Settle ownership that must transfer only when session setup or rendering fails. */
  onFailure?: (error: unknown) => void | Promise<void>;
  /** Settle process-level resources that must close while the terminal surface is still mounted. */
  beforeTeardown?: () => void | Promise<void>;
  render(context: HunkSessionRenderContext): ReactNode;
}

export interface HunkSessionRunnerDeps {
  createRenderer?: typeof createCliRenderer;
  createReactRoot?: typeof createRoot;
  installInterrupt?: typeof installJobControlInterruptSupport;
  installSuspend?: typeof installJobControlSuspendSupport;
  installDisconnect?: typeof installTerminalDisconnectSupport;
  disposeWorker?: typeof disposeHighlightWorker;
  onSignal?: (signal: NodeJS.Signals, listener: SignalListener) => unknown;
  offSignal?: (signal: NodeJS.Signals, listener: SignalListener) => unknown;
}

/**
 * Run one interactive Hunk session through one renderer and one React root.
 *
 * Surface hosts acknowledge graceful completion with `finish`; signals only request that
 * completion, so extension retirement and started writes settle before terminal teardown.
 */
export async function runHunkSession(
  options: HunkSessionRunnerOptions,
  deps: HunkSessionRunnerDeps = {},
): Promise<number | undefined> {
  const createRenderer = deps.createRenderer ?? createCliRenderer;
  const createReactRoot = deps.createReactRoot ?? createRoot;
  const installInterrupt = deps.installInterrupt ?? installJobControlInterruptSupport;
  const installSuspend = deps.installSuspend ?? installJobControlSuspendSupport;
  const installDisconnect = deps.installDisconnect ?? installTerminalDisconnectSupport;
  const disposeWorker = deps.disposeWorker ?? disposeHighlightWorker;
  const onSignal = deps.onSignal ?? process.once.bind(process);
  const offSignal = deps.offSignal ?? process.off.bind(process);

  const quitController = new AbortController();
  let renderer: Renderer | undefined;
  let root: Root | undefined;
  let interrupt: JobControlInterruptSupport = { dispose: () => undefined };
  let suspend: JobControlSuspendSupport = { dispose: () => undefined };
  let disconnect: TerminalDisconnectSupport = { dispose: () => undefined };
  let settled = false;
  let requestedExitCode: number | undefined;
  let finishOutcome!: (exitCode?: number) => void;
  const outcome = new Promise<number | undefined>((resolve) => {
    finishOutcome = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve(exitCode ?? requestedExitCode);
    };
  });
  const requestQuit = (exitCode?: number) => {
    if (requestedExitCode === undefined) requestedExitCode = exitCode;
    if (!quitController.signal.aborted) quitController.abort();
  };
  const signalHandlers = new Map<NodeJS.Signals, SignalListener>(
    options.signals.map((signal) => [signal, () => requestQuit(options.signalExitCode?.(signal))]),
  );
  let rendererDestroyNotified = false;
  const notifyRendererDestroy = () => {
    if (rendererDestroyNotified) return;
    rendererDestroyNotified = true;
    options.onRendererDestroy?.();
  };
  let result: number | undefined;
  let failure: unknown;
  let failed = false;
  const recordFailure = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
  };
  const attempt = (action: () => void) => {
    try {
      action();
    } catch (error) {
      recordFailure(error);
    }
  };

  try {
    renderer = await createRenderer({
      stdin: options.stdin,
      stdout: options.stdout,
      useMouse: options.useMouse,
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      // OpenTUI's destroy-only handlers can strand sessions with active broker handles.
      exitSignals: [],
      openConsoleOnError: true,
      onDestroy: notifyRendererDestroy,
    });
    root = createReactRoot(renderer);
    interrupt = installInterrupt(renderer, () => requestQuit(options.interruptExitCode));
    suspend = installSuspend(renderer);
    disconnect = installDisconnect(options.stdin, () => requestQuit());
    for (const [signal, handler] of signalHandlers) onSignal(signal, handler);
    root.render(
      options.render({
        externalQuitSignal: quitController.signal,
        finish: finishOutcome,
      }),
    );
    result = await outcome;
  } catch (error) {
    recordFailure(error);
    try {
      await options.onFailure?.(error);
    } catch (cleanupError) {
      recordFailure(cleanupError);
    }
  } finally {
    try {
      await options.beforeTeardown?.();
    } catch (error) {
      recordFailure(error);
    }
    for (const [signal, handler] of signalHandlers) {
      attempt(() => offSignal(signal, handler));
    }
    attempt(() => interrupt.dispose());
    attempt(() => suspend.dispose());
    attempt(() => disconnect.dispose());
    attempt(disposeWorker);
    const mountedRoot = root;
    const activeRenderer = renderer;
    if (mountedRoot) attempt(() => mountedRoot.unmount());
    if (activeRenderer) attempt(() => activeRenderer.destroy());
    attempt(notifyRendererDestroy);
  }

  if (failed) throw failure;
  return result;
}
