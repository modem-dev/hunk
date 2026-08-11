import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  installJobControlInterruptSupport,
  installJobControlSuspendSupport,
  type JobControlInterruptSupport,
  type JobControlSuspendSupport,
} from "../core/jobControl";
import { shutdownSession } from "../core/shutdown";
import { shouldUseMouseForApp, type ControllingTerminal } from "../core/terminal";
import type { AppBootstrap, CliInput } from "../core/types";
import { resolveStartupUpdateNotice } from "../core/updateNotice";
import type { ReviewSessionRuntime } from "../app/reviewSessionRuntime";
import type { HunkSessionBrokerClient } from "../session/types";
import { AppHost } from "./AppHost";

export interface InteractiveAppInput {
  bootstrap: AppBootstrap;
  rawInput: CliInput;
  controllingTerminal: ControllingTerminal | null;
  runtime: ReviewSessionRuntime;
  hostClient?: HunkSessionBrokerClient;
  sessionNotice?: string;
}

export interface InteractiveAppRuntimeDeps {
  createCliRendererImpl?: typeof createCliRenderer;
  createRootImpl?: typeof createRoot;
  installJobControlInterruptSupportImpl?: typeof installJobControlInterruptSupport;
  installJobControlSuspendSupportImpl?: typeof installJobControlSuspendSupport;
  shutdownSessionImpl?: typeof shutdownSession;
  onSignalImpl?: (signal: NodeJS.Signals, listener: () => void) => void;
  offSignalImpl?: (signal: NodeJS.Signals, listener: () => void) => void;
}

/** Load and run the OpenTUI review app after startup has selected an interactive plan. */
export async function runInteractiveApp(
  {
    bootstrap,
    rawInput,
    controllingTerminal,
    runtime,
    hostClient,
    sessionNotice,
  }: InteractiveAppInput,
  deps: InteractiveAppRuntimeDeps = {},
): Promise<void> {
  const createCliRendererImpl = deps.createCliRendererImpl ?? createCliRenderer;
  const createRootImpl = deps.createRootImpl ?? createRoot;
  const installInterruptImpl =
    deps.installJobControlInterruptSupportImpl ?? installJobControlInterruptSupport;
  const installSuspendImpl =
    deps.installJobControlSuspendSupportImpl ?? installJobControlSuspendSupport;
  const shutdownSessionImpl = deps.shutdownSessionImpl ?? shutdownSession;
  const onSignalImpl = deps.onSignalImpl ?? ((signal, listener) => process.once(signal, listener));
  const offSignalImpl = deps.offSignalImpl ?? ((signal, listener) => process.off(signal, listener));
  // Keep OpenTUI's platform-safe threading default (enabled on macOS, disabled on Linux).
  const renderer = await createCliRendererImpl({
    stdin: controllingTerminal?.stdin,
    stdout: process.stdout,
    useMouse: shouldUseMouseForApp({
      hasControllingTerminal: Boolean(controllingTerminal),
    }),
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    openConsoleOnError: true,
    onDestroy: () => controllingTerminal?.close(),
  });

  const appRenderer = renderer;
  let root: ReturnType<typeof createRoot>;
  try {
    root = createRootImpl(appRenderer);
  } catch (error) {
    try {
      appRenderer.destroy();
    } catch {
      // Root construction remains the authoritative startup failure.
    }
    throw error;
  }
  const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let shuttingDown = false;
  let jobControlSuspendSupport: JobControlSuspendSupport = { dispose: () => undefined };
  let jobControlInterruptSupport: JobControlInterruptSupport = { dispose: () => undefined };

  /** Release terminal-owned resources, optionally completing a normal process exit. */
  function teardown(exit: boolean) {
    if (shuttingDown) return;
    shuttingDown = true;
    let firstError: unknown;
    let hasError = false;
    /** Continue through every owner while retaining the first cleanup failure. */
    const attempt = (cleanup: () => void) => {
      try {
        cleanup();
      } catch (error) {
        if (!hasError) firstError = error;
        hasError = true;
      }
    };

    for (const signal of shutdownSignals) attempt(() => offSignalImpl(signal, shutdown));
    attempt(() => jobControlInterruptSupport.dispose());
    attempt(() => jobControlSuspendSupport.dispose());
    attempt(() => hostClient?.stop());
    if (exit) attempt(() => shutdownSessionImpl({ root, renderer: appRenderer }));
    else {
      attempt(() => root.unmount());
      attempt(() => appRenderer.destroy());
    }
    if (hasError) throw firstError;
  }

  /** Tear down the renderer before exit so the primary terminal screen comes back cleanly. */
  function shutdown() {
    teardown(true);
  }

  try {
    for (const signal of shutdownSignals) {
      onSignalImpl(signal, shutdown);
    }
    jobControlInterruptSupport = installInterruptImpl(appRenderer, shutdown);
    jobControlSuspendSupport = installSuspendImpl(appRenderer);

    // The app owns the full alternate screen session from this point on.
    root.render(
      <AppHost
        bootstrap={bootstrap}
        hostClient={hostClient}
        rawInput={rawInput}
        onQuit={shutdown}
        startupNoticeResolver={resolveStartupUpdateNotice}
        runtime={runtime}
        initialNotice={sessionNotice}
      />,
    );
  } catch (error) {
    try {
      teardown(false);
    } catch {
      // Startup/render failure remains authoritative over cleanup failures.
    }
    throw error;
  }
}
