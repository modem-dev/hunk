import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  installJobControlInterruptSupport,
  installJobControlSuspendSupport,
  type JobControlInterruptSupport,
  type JobControlSuspendSupport,
} from "../core/process/jobControl";
import { shutdownSession } from "../core/process/shutdown";
import {
  installTerminalDisconnectSupport,
  shouldUseMouseForApp,
  type ControllingTerminal,
  type TerminalDisconnectSupport,
} from "../core/process/terminal";
import type { AppBootstrap } from "../core/bootstrap";
import { resolveStartupUpdateNotice } from "../core/process/updateNotice";
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
import { disposeHighlightWorker } from "./diff/worker";
import { retireExtensionLoadResult } from "../extensions/events";
import type { ExtensionLoadResult } from "../extensions/types";

export interface InteractiveAppInput {
  bootstrap: AppBootstrap<ExtensionLoadResult>;
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
  let renderer: Awaited<ReturnType<typeof createCliRenderer>>;
  try {
    renderer = await createCliRenderer({
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
  } catch (error) {
    hostClient.stop();
    controllingTerminal?.close();
    await retireExtensionLoadResult(bootstrap.extensions);
    throw error;
  }

  const appRenderer = renderer;
  let root: ReturnType<typeof createRoot>;
  try {
    root = createRoot(appRenderer);
  } catch (error) {
    hostClient.stop();
    appRenderer.destroy();
    controllingTerminal?.close();
    await retireExtensionLoadResult(bootstrap.extensions);
    throw error;
  }
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
  function shutdown(exitProcess = true) {
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
    // Release the syntax worker here rather than from the executable entrypoint: this function
    // returns once the app is mounted, so an entrypoint-side dispose would fire before the first
    // eligible diff ever asked for the worker.
    disposeHighlightWorker();
    shutdownSession({
      root,
      renderer: appRenderer,
      ...(exitProcess ? {} : { exit: () => undefined }),
    });
  }

  try {
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
  } catch (error) {
    shutdown(false);
    await retireExtensionLoadResult(bootstrap.extensions);
    throw error;
  }
}
