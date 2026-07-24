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
import type { AppBootstrap } from "../core/types";
import { resolveStartupUpdateNotice } from "../core/updateNotice";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
} from "../hunk-session/sessionRegistration";
import type {
  HunkSessionCommandResult,
  HunkSessionInfo,
  HunkSessionServerMessage,
  HunkSessionState,
} from "../hunk-session/types";
import { SessionBrokerClient } from "../session-broker/brokerClient";
import { AppHost } from "./AppHost";

export interface InteractiveAppInput {
  bootstrap: AppBootstrap;
  controllingTerminal: ControllingTerminal | null;
}

/** Load and run the OpenTUI review app after startup has selected an interactive plan. */
export async function runInteractiveApp({
  bootstrap,
  controllingTerminal,
}: InteractiveAppInput): Promise<void> {
  const hostClient = new SessionBrokerClient<
    HunkSessionInfo,
    HunkSessionState,
    HunkSessionServerMessage,
    HunkSessionCommandResult
  >(createSessionRegistration(bootstrap), createInitialSessionSnapshot(bootstrap));
  hostClient.start();

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
  const root = createRoot(appRenderer);
  const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let shuttingDown = false;
  let jobControlSuspendSupport: JobControlSuspendSupport = { dispose: () => undefined };
  let jobControlInterruptSupport: JobControlInterruptSupport = { dispose: () => undefined };

  /** Tear down the renderer before exit so the primary terminal screen comes back cleanly. */
  function shutdown() {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const signal of shutdownSignals) {
      process.off(signal, shutdown);
    }
    jobControlInterruptSupport.dispose();
    jobControlSuspendSupport.dispose();
    hostClient.stop();
    shutdownSession({ root, renderer: appRenderer });
  }

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
      onQuit={shutdown}
      startupNoticeResolver={resolveStartupUpdateNotice}
    />,
  );
}
