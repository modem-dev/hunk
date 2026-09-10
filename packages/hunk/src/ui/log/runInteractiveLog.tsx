import { HunkUserError } from "../../core/run/errors";
import type { InteractiveHistoryRuntime } from "../history/types";
import { HunkSessionHost, type HistorySurfaceRoute } from "../session/HunkSessionHost";
import { runHunkSession } from "../session/runHunkSession";
import { LogController } from "./controller";

export const LOG_SHUTDOWN_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];

/** Translate terminal shutdown signals to conventional shell exit codes. */
export function logSignalExitCode(signal: NodeJS.Signals) {
  return signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
}

/** Browse history and fresh commit reviews inside one renderer and one stable React root. */
export async function runInteractiveLog(
  runtime: InteractiveHistoryRuntime,
  {
    stdin = process.stdin,
    stdout = process.stdout,
  }: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {},
) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    try {
      await runtime.close();
    } finally {
      await runtime.extensionSession.shutdown();
    }
    throw new HunkUserError("The `hunk log` browser requires a terminal.", [
      "Use `hunk log --static` to force scrollback output.",
    ]);
  }

  const controller = new LogController(runtime);
  const initialRoute: HistorySurfaceRoute = { kind: "history", controller, runtime };

  let runnerOwnsCleanup = false;
  try {
    await controller.loadMore();
    runnerOwnsCleanup = true;
    const exitCode = await runHunkSession({
      stdin,
      stdout,
      useMouse: true,
      signals: LOG_SHUTDOWN_SIGNALS,
      signalExitCode: logSignalExitCode,
      interruptExitCode: 130,
      beforeTeardown: async () => {
        try {
          await controller.close();
        } finally {
          await runtime.extensionSession.shutdown();
        }
      },
      render: ({ externalQuitSignal, finish }) => (
        <HunkSessionHost
          initialRoute={initialRoute}
          initialization={runtime.initialization}
          externalQuitSignal={externalQuitSignal}
          onQuit={finish}
        />
      ),
    });
    if (exitCode !== undefined) process.exitCode = exitCode;
  } finally {
    if (!runnerOwnsCleanup) {
      try {
        await controller.close();
      } finally {
        await runtime.extensionSession.shutdown();
      }
    }
  }
}
