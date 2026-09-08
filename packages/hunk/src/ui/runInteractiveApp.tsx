import { shouldUseMouseForApp, type ControllingTerminal } from "../core/process/terminal";
import type { AppBootstrap } from "../core/bootstrap";
import { resolveStartupUpdateNotice } from "../core/process/updateNotice";
import { createReviewSessionRuntime } from "../app/session/reviewRuntime";
import { createSessionReloadBounds } from "../app/session/reloadBounds";
import type { InteractiveSessionInitialization } from "../core/session/initialization";
import { createExtensionSession } from "../extensions/session";
import type { ExtensionLoadResult } from "../extensions/types";
import { HunkSessionHost, type StandaloneReviewSurfaceRoute } from "./session/HunkSessionHost";
import { runHunkSession } from "./session/runHunkSession";

export interface InteractiveAppInput {
  bootstrap: AppBootstrap<ExtensionLoadResult>;
  controllingTerminal: ControllingTerminal | null;
  initialization: InteractiveSessionInitialization;
}

export interface InteractiveAppDeps {
  createReviewRuntime?: typeof createReviewSessionRuntime;
  runSession?: typeof runHunkSession;
}

// Leave fatal process faults to their default OS disposition.
export const APP_SHUTDOWN_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGPIPE"];

/** Load and run the OpenTUI review app after startup has selected an interactive plan. */
export async function runInteractiveApp(
  { bootstrap, controllingTerminal, initialization }: InteractiveAppInput,
  deps: InteractiveAppDeps = {},
): Promise<void> {
  const createReviewRuntime = deps.createReviewRuntime ?? createReviewSessionRuntime;
  const runSession = deps.runSession ?? runHunkSession;
  const rendererStdin = controllingTerminal?.stdin ?? process.stdin;
  let terminalClosed = false;
  const closeTerminal = () => {
    if (terminalClosed) return;
    terminalClosed = true;
    controllingTerminal?.close();
  };
  if (!bootstrap.extensions) {
    controllingTerminal?.close();
    throw new Error("Interactive review startup did not provide extension authority.");
  }
  const extensionSession = createExtensionSession(
    bootstrap.extensions,
    createSessionReloadBounds(bootstrap, { cwd: bootstrap.reloadContext.cwd }).defaultCwd,
  );
  let reviewRuntime: ReturnType<typeof createReviewSessionRuntime> | undefined;
  let runnerOwnsFailureCleanup = false;
  let runtimeCleanupAttempted = false;

  try {
    reviewRuntime = createReviewRuntime(bootstrap, bootstrap.reloadContext.cwd);
    const initialRoute: StandaloneReviewSurfaceRoute = {
      kind: "review",
      instanceId: 1,
      bootstrap,
      runtime: reviewRuntime,
      extensionSession,
    };
    runnerOwnsFailureCleanup = true;
    await runSession({
      stdin: rendererStdin,
      stdout: process.stdout,
      useMouse: shouldUseMouseForApp({
        hasControllingTerminal: Boolean(controllingTerminal),
      }),
      signals: APP_SHUTDOWN_SIGNALS,
      onRendererDestroy: closeTerminal,
      onFailure: async () => {
        try {
          reviewRuntime?.stop();
          runtimeCleanupAttempted = true;
        } finally {
          await extensionSession.shutdown();
        }
      },
      beforeTeardown: async () => {
        await extensionSession.shutdown();
        if (runtimeCleanupAttempted) return;
        reviewRuntime?.stop();
        runtimeCleanupAttempted = true;
      },
      render: ({ externalQuitSignal, finish }) => (
        <HunkSessionHost
          initialRoute={initialRoute}
          initialization={initialization}
          externalQuitSignal={externalQuitSignal}
          onQuit={finish}
          startupNoticeResolver={resolveStartupUpdateNotice}
        />
      ),
    });
  } catch (error) {
    if (!runnerOwnsFailureCleanup) await extensionSession.shutdown();
    throw error;
  } finally {
    if (!runtimeCleanupAttempted) reviewRuntime?.stop();
    closeTerminal();
  }
}
