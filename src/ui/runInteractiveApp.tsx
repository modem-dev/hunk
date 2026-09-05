import { createNativeSessionBrokerLifecycleClock } from "@hunk/session-broker";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { resolve } from "node:path";
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
import { prepareStartupPlan } from "../app/startup";
import { ReviewProducer } from "../app/review/producer";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
} from "../app/session/registration";
import { SessionBrokerClient } from "../session/broker/brokerClient";
import { reportHunkSessionBrokerLifecycleDefect } from "../session/broker/lifecycleDefect";
import type { ExtensionVcsHistoryReviewAction } from "../extension-api/types";
import type { HistoryRuntime } from "./history/types";
import { historyReviewArgs } from "./log/reviewLaunch";
import { AppHost } from "./AppHost";
import { disposeHighlightWorker } from "./diff/worker";
import { retireExtensionLoadResult } from "../extensions/events";
import type { ExtensionLoadResult } from "../extensions/types";

export interface InteractiveAppInput {
  bootstrap: AppBootstrap<ExtensionLoadResult>;
  controllingTerminal: ControllingTerminal | null;
}

export interface ReviewSessionRuntime {
  hostClient: SessionBrokerClient;
  reviewProducer: ReviewProducer;
  stop(): void;
}

export interface EmbeddedHistoryReview {
  bootstrap: AppBootstrap<ExtensionLoadResult>;
  /** The history runtime owns this bootstrap's extension registry. */
  borrowsExtensions: boolean;
}

/** Create broker and producer resources for one independently mountable review surface. */
export function createReviewSessionRuntime(
  bootstrap: AppBootstrap<ExtensionLoadResult>,
  cwd = process.cwd(),
): ReviewSessionRuntime {
  const reviewProducer = new ReviewProducer({
    files: bootstrap.changeset.files,
    sourceLabel: bootstrap.changeset.sourceLabel,
  });
  const publication = reviewProducer.getPublication();
  const lifecycleClock = createNativeSessionBrokerLifecycleClock();
  const hostClient = new SessionBrokerClient(
    createSessionRegistration(bootstrap, publication, cwd),
    createInitialSessionSnapshot(bootstrap, publication),
    { lifecycleClock, onDefect: reportHunkSessionBrokerLifecycleDefect },
  );
  hostClient.start();
  let stopped = false;
  return {
    hostClient,
    reviewProducer,
    stop() {
      if (stopped) return;
      stopped = true;
      hostClient.stop();
    },
  };
}

/** Bootstrap one provider-planned history review without creating or claiming a renderer. */
export async function prepareEmbeddedHistoryReview(
  runtime: HistoryRuntime,
  action: ExtensionVcsHistoryReviewAction,
  {
    themeId,
    themeMode,
    signal,
    env = process.env,
    prepareStartupPlanImpl = prepareStartupPlan,
  }: {
    themeId?: string;
    themeMode?: "dark" | "light";
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    prepareStartupPlanImpl?: typeof prepareStartupPlan;
  } = {},
): Promise<EmbeddedHistoryReview> {
  signal?.throwIfAborted();
  const startupCwd = runtime.startupCwd ?? runtime.repoRoot;
  const extensionArgs = runtime.input.extensionPaths.flatMap((path) => [
    "--extension",
    resolve(startupCwd, path),
  ]);
  const args = [
    ...historyReviewArgs(action),
    "--vcs",
    runtime.providerId,
    ...(themeId ? ["--theme", themeId] : []),
    ...(runtime.input.extensionsEnabled ? extensionArgs : ["--no-extensions"]),
  ];
  const plan = await prepareStartupPlanImpl(["hunk", "hunk", ...args], {
    cwd: startupCwd,
    env,
    signal,
    borrowedExtensionLoad: runtime.extensionSession,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    terminalThemeMode: themeMode,
  });
  if (signal?.aborted && plan.kind === "app") {
    plan.controllingTerminal?.close();
    if (plan.bootstrap.extensions !== runtime.extensionSession) {
      await retireExtensionLoadResult(plan.bootstrap.extensions);
    }
    signal.throwIfAborted();
  }
  if (plan.kind !== "app") {
    throw new Error("The selected commit did not produce an interactive review.");
  }
  plan.controllingTerminal?.close();
  return {
    bootstrap: plan.bootstrap as AppBootstrap<ExtensionLoadResult>,
    borrowsExtensions: plan.bootstrap.extensions === runtime.extensionSession,
  };
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
  const reviewSession = createReviewSessionRuntime(bootstrap, bootstrap.reloadContext.cwd);
  const { hostClient, reviewProducer } = reviewSession;

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
    reviewSession.stop();
    controllingTerminal?.close();
    await retireExtensionLoadResult(bootstrap.extensions);
    throw error;
  }

  const appRenderer = renderer;
  let root: ReturnType<typeof createRoot>;
  try {
    root = createRoot(appRenderer);
  } catch (error) {
    reviewSession.stop();
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
    reviewSession.stop();
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
