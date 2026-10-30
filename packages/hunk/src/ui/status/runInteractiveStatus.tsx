import { HunkUserError } from "../../core/run/errors";
import { assertReliableWatchRuntime } from "../../core/watch/runtime";
import { HunkSessionHost } from "../session/HunkSessionHost";
import { runHunkSession } from "../session/runHunkSession";
import { LOG_SHUTDOWN_SIGNALS, logSignalExitCode } from "../log/runInteractiveLog";
import { StatusController } from "./controller";
import type { StatusRuntime } from "./types";

/** Run status, retained log and fresh reviews in one renderer with one extension lifetime. */
export async function runInteractiveStatus(
  runtime: StatusRuntime,
  {
    stdin = process.stdin,
    stdout = process.stdout,
  }: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {},
) {
  const controller = new StatusController(runtime);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await controller.close();
    } finally {
      await runtime.extensionSession.shutdown();
    }
  };
  try {
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function")
      throw new HunkUserError("The `hunk status` browser requires a terminal.", [
        "Use `hunk status --static` for scrollback output.",
      ]);
    assertReliableWatchRuntime(Bun.version);
    const exitCode = await runHunkSession({
      stdin,
      stdout,
      useMouse: true,
      signals: LOG_SHUTDOWN_SIGNALS,
      signalExitCode: logSignalExitCode,
      interruptExitCode: 130,
      beforeTeardown: cleanup,
      render: ({ externalQuitSignal, finish }) => (
        <HunkSessionHost
          initialRoute={{ kind: "status", controller, runtime }}
          initialization={runtime.initialization}
          externalQuitSignal={externalQuitSignal}
          onQuit={finish}
        />
      ),
    });
    if (exitCode !== undefined) process.exitCode = exitCode;
  } finally {
    await cleanup();
  }
}
