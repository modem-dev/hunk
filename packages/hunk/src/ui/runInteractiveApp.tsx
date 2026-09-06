import { shouldUseMouseForApp, type ControllingTerminal } from "../core/process/terminal";
import type { AppBootstrap } from "../core/bootstrap";
import { resolveStartupUpdateNotice } from "../core/process/updateNotice";
import { createReviewSessionRuntime } from "../app/session/reviewRuntime";
import { retireExtensionLoadResult } from "../extensions/events";
import type { ExtensionLoadResult } from "../extensions/types";
import { HunkSessionHost, type StandaloneReviewSurfaceRoute } from "./session/HunkSessionHost";
import { runHunkSession } from "./session/runHunkSession";

export interface InteractiveAppInput {
  bootstrap: AppBootstrap<ExtensionLoadResult>;
  controllingTerminal: ControllingTerminal | null;
}

export interface InteractiveAppDeps {
  createReviewRuntime?: typeof createReviewSessionRuntime;
  runSession?: typeof runHunkSession;
  retireExtensions?: typeof retireExtensionLoadResult;
}

// Leave fatal process faults to their default OS disposition.
export const APP_SHUTDOWN_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGPIPE"];

/** Load and run the OpenTUI review app after startup has selected an interactive plan. */
export async function runInteractiveApp(
  { bootstrap, controllingTerminal }: InteractiveAppInput,
  deps: InteractiveAppDeps = {},
): Promise<void> {
  const createReviewRuntime = deps.createReviewRuntime ?? createReviewSessionRuntime;
  const runSession = deps.runSession ?? runHunkSession;
  const retireExtensions = deps.retireExtensions ?? retireExtensionLoadResult;
  const rendererStdin = controllingTerminal?.stdin ?? process.stdin;
  let terminalClosed = false;
  const closeTerminal = () => {
    if (terminalClosed) return;
    terminalClosed = true;
    controllingTerminal?.close();
  };
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
          await retireExtensions(bootstrap.extensions);
        }
      },
      beforeTeardown: () => {
        if (runtimeCleanupAttempted) return;
        reviewRuntime?.stop();
        runtimeCleanupAttempted = true;
      },
      render: ({ externalQuitSignal, finish }) => (
        <HunkSessionHost
          initialRoute={initialRoute}
          externalQuitSignal={externalQuitSignal}
          onQuit={finish}
          startupNoticeResolver={resolveStartupUpdateNotice}
        />
      ),
    });
  } catch (error) {
    if (!runnerOwnsFailureCleanup) await retireExtensions(bootstrap.extensions);
    throw error;
  } finally {
    if (!runtimeCleanupAttempted) reviewRuntime?.stop();
    closeTerminal();
  }
}
