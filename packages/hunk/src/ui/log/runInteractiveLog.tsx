import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  installJobControlInterruptSupport,
  installJobControlSuspendSupport,
  type JobControlInterruptSupport,
  type JobControlSuspendSupport,
} from "../../core/process/jobControl";
import { shutdownSession } from "../../core/process/shutdown";
import { HunkUserError } from "../../core/run/errors";
import {
  installTerminalDisconnectSupport,
  type TerminalDisconnectSupport,
} from "../../core/process/terminal";
import { disposeHighlightWorker } from "../diff/worker";
import type { HistoryRuntime } from "../history/types";
import { LogController } from "./controller";
import { LogSessionHost } from "./LogSessionHost";

const LOG_SHUTDOWN_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];

/** Translate terminal shutdown signals to conventional shell exit codes. */
export function logSignalExitCode(signal: NodeJS.Signals) {
  return signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
}

/** Browse history and fresh commit reviews inside one renderer and one stable React root. */
export async function runInteractiveLog(
  runtime: HistoryRuntime,
  {
    stdin = process.stdin,
    stdout = process.stdout,
  }: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {},
) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    await runtime.close();
    throw new HunkUserError("The `hunk log` browser requires a terminal.", [
      "Use `hunk log --static` to force scrollback output.",
    ]);
  }

  const controller = new LogController(runtime);
  const quitController = new AbortController();
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;
  let root: ReturnType<typeof createRoot> | undefined;
  let interrupt: JobControlInterruptSupport = { dispose: () => undefined };
  let suspend: JobControlSuspendSupport = { dispose: () => undefined };
  let disconnect: TerminalDisconnectSupport = { dispose: () => undefined };
  let settled = false;
  let finish!: (exitCode?: number) => void;
  const outcome = new Promise<number | undefined>((resolve) => {
    finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve(exitCode);
    };
  });
  const requestQuit = () => quitController.abort();
  const requestInterrupt = () => {
    process.exitCode = 130;
    quitController.abort();
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>(
    LOG_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      () => {
        process.exitCode = logSignalExitCode(signal);
        quitController.abort();
      },
    ]),
  );

  try {
    await controller.loadMore();
    renderer = await createCliRenderer({
      stdin,
      stdout,
      useMouse: true,
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
      openConsoleOnError: true,
    });
    root = createRoot(renderer);
    interrupt = installJobControlInterruptSupport(renderer, requestInterrupt);
    suspend = installJobControlSuspendSupport(renderer);
    disconnect = installTerminalDisconnectSupport(stdin, requestQuit);
    for (const [signal, handler] of signalHandlers) process.once(signal, handler);
    root.render(
      <LogSessionHost
        controller={controller}
        runtime={runtime}
        externalQuitSignal={quitController.signal}
        onQuit={finish}
      />,
    );
    const exitCode = await outcome;
    if (exitCode !== undefined) process.exitCode = exitCode;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    interrupt.dispose();
    suspend.dispose();
    disconnect.dispose();
    disposeHighlightWorker();
    if (root && renderer) shutdownSession({ root, renderer, exit: () => undefined });
    else renderer?.destroy();
    await controller.close();
  }
}
