import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  installJobControlInterruptSupport,
  installJobControlSuspendSupport,
  type JobControlInterruptSupport,
  type JobControlSuspendSupport,
} from "../core/jobControl";
import { shutdownSession } from "../core/shutdown";
import {
  installTerminalDisconnectSupport,
  shouldUseMouseForApp,
  type ControllingTerminal,
  type TerminalDisconnectSupport,
} from "../core/terminal";
import type { AppBootstrap } from "../core/types";
import { resolveStartupUpdateNotice } from "../core/updateNotice";
import { ReviewProducer } from "../app/review/producer";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
} from "../app/session/registration";
import type {
  HunkSessionCommandResult,
  HunkSessionInfo,
  HunkSessionServerMessage,
  HunkSessionState,
} from "../session/types";
import { SessionBrokerClient } from "../session/broker/brokerClient";
import { AppHost } from "./AppHost";

export interface InteractiveAppInput {
  bootstrap: AppBootstrap;
  controllingTerminal: ControllingTerminal | null;
}

// Leave fatal process faults to their default OS disposition.
const APP_SHUTDOWN_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGPIPE"];

/** Load and run the OpenTUI review app after startup has selected an interactive plan. */
export async function runInteractiveApp({
  bootstrap,
  controllingTerminal,
}: InteractiveAppInput): Promise<void> {
  // One producer owns this review's generations for the life of the process: the
  // registration and the first snapshot are projections of its first publication, and every
  // reload publishes the next one through the same object.
  const reviewProducer = new ReviewProducer({
    files: bootstrap.changeset.files,
    sourceLabel: bootstrap.changeset.sourceLabel,
  });
  const publication = reviewProducer.getPublication();
  const hostClient = new SessionBrokerClient<
    HunkSessionInfo,
    HunkSessionState,
    HunkSessionServerMessage,
    HunkSessionCommandResult
  >(
    createSessionRegistration(bootstrap, publication),
    createInitialSessionSnapshot(bootstrap, publication),
  );
  hostClient.start();

  // Keep OpenTUI's platform-safe threading default (enabled on macOS, disabled on Linux).
  const rendererStdin = controllingTerminal?.stdin ?? process.stdin;
  const renderer = await createCliRenderer({
    stdin: rendererStdin,
    stdout: process.stdout,
    useMouse: shouldUseMouseForApp({
      hasControllingTerminal: Boolean(controllingTerminal),
    }),
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    // OpenTUI's destroy-only handlers can strand sessions with active broker handles.
    exitSignals: [],
    openConsoleOnError: true,
    onDestroy: () => controllingTerminal?.close(),
  });

  const appRenderer = renderer;
  const root = createRoot(appRenderer);
  const externalQuitController = new AbortController();
  let shuttingDown = false;
  let jobControlSuspendSupport: JobControlSuspendSupport = { dispose: () => undefined };
  let jobControlInterruptSupport: JobControlInterruptSupport = { dispose: () => undefined };
  let terminalDisconnectSupport: TerminalDisconnectSupport = { dispose: () => undefined };

  /** Ask AppHost to retire extension authority before tearing down the terminal. */
  function requestQuit() {
    externalQuitController.abort();
  }

  /** Tear down the renderer before exit so the primary terminal screen comes back cleanly. */
  function shutdown() {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const signal of APP_SHUTDOWN_SIGNALS) {
      process.off(signal, requestQuit);
    }
    jobControlInterruptSupport.dispose();
    jobControlSuspendSupport.dispose();
    terminalDisconnectSupport.dispose();
    hostClient.stop();
    shutdownSession({ root, renderer: appRenderer });
  }

  for (const signal of APP_SHUTDOWN_SIGNALS) {
    process.once(signal, requestQuit);
  }
  // Install after the renderer so a disconnect closes the live session instead of racing startup.
  terminalDisconnectSupport = installTerminalDisconnectSupport(rendererStdin, requestQuit);
  jobControlInterruptSupport = installJobControlInterruptSupport(appRenderer, requestQuit);
  jobControlSuspendSupport = installJobControlSuspendSupport(appRenderer);

  // The app owns the full alternate screen session from this point on.
  root.render(
    <AppHost
      bootstrap={bootstrap}
      externalQuitSignal={externalQuitController.signal}
      hostClient={hostClient}
      onQuit={shutdown}
      reviewProducer={reviewProducer}
      startupNoticeResolver={resolveStartupUpdateNotice}
    />,
  );
}
