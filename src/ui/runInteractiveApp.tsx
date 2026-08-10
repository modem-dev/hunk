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

/** Load and run the OpenTUI review app after startup has selected an interactive plan. */
export async function runInteractiveApp({
  bootstrap,
  rawInput,
  controllingTerminal,
  runtime,
  hostClient,
  sessionNotice,
}: InteractiveAppInput): Promise<void> {
  // Keep OpenTUI's platform-safe threading default (enabled on macOS, disabled on Linux).
  const renderer = await createCliRenderer({
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
    root = createRoot(appRenderer);
  } catch (error) {
    appRenderer.destroy();
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
    for (const signal of shutdownSignals) process.off(signal, shutdown);
    jobControlInterruptSupport.dispose();
    jobControlSuspendSupport.dispose();
    hostClient?.stop();
    if (exit) {
      shutdownSession({ root, renderer: appRenderer });
      return;
    }
    try {
      root.unmount();
    } finally {
      appRenderer.destroy();
    }
  }

  /** Tear down the renderer before exit so the primary terminal screen comes back cleanly. */
  function shutdown() {
    teardown(true);
  }

  try {
    for (const signal of shutdownSignals) {
      process.once(signal, shutdown);
    }
    jobControlInterruptSupport = installJobControlInterruptSupport(appRenderer, shutdown);
    jobControlSuspendSupport = installJobControlSuspendSupport(appRenderer);

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
    teardown(false);
    throw error;
  }
}
