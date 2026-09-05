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
import { LogApp, type LogAppOutcome } from "./LogApp";
import { LogController } from "./controller";
import { prepareHistoryReview, type PreparedHistoryReview } from "./reviewLaunch";
import type { HistoryRuntime } from "../history/types";
import { interactiveLogUsesColor } from "./colorPolicy";

const LOG_SHUTDOWN_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];

/** Translate terminal shutdown signals to conventional shell exit codes. */
export function logSignalExitCode(signal: NodeJS.Signals) {
  return signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
}

type MountedLogOutcome =
  | Extract<LogAppOutcome, { kind: "quit" }>
  | { kind: "open-review"; launch: PreparedHistoryReview };

/** Mount one OpenTUI log surface and keep it visible while the selected review bootstraps. */
async function mountLogSurface(
  controller: LogController,
  runtime: HistoryRuntime,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
) {
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    useMouse: true,
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    exitSignals: [],
    openConsoleOnError: true,
  });
  let root: ReturnType<typeof createRoot>;
  try {
    root = createRoot(renderer);
  } catch (error) {
    renderer.destroy();
    throw error;
  }
  let settled = false;
  let settle!: (outcome: MountedLogOutcome) => void;
  const outcome = new Promise<MountedLogOutcome>((resolve) => {
    settle = resolve;
  });
  const launchAbort = new AbortController();
  let preparedLaunch: PreparedHistoryReview | undefined;
  const finish = (value: MountedLogOutcome) => {
    if (settled) return;
    settled = true;
    settle(value);
  };
  const handleOutcome = async (value: LogAppOutcome) => {
    if (value.kind === "quit") {
      launchAbort.abort();
      finish(value);
      return;
    }
    const launch = await prepareHistoryReview(runtime, value.action, {
      themeId: value.themeId,
      themeMode: value.themeMode,
      signal: launchAbort.signal,
    });
    if (settled) {
      await launch.abort();
      return;
    }
    preparedLaunch = launch;
    finish({ kind: "open-review", launch });
  };
  const requestQuit = () => finish({ kind: "quit" });
  const requestInterrupt = () => finish({ kind: "quit", exitCode: 130 });
  const signalHandlers = new Map<NodeJS.Signals, () => void>(
    LOG_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      () =>
        finish({
          kind: "quit",
          exitCode: logSignalExitCode(signal),
        }),
    ]),
  );
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  let interrupt: JobControlInterruptSupport = { dispose: () => undefined };
  let suspend: JobControlSuspendSupport = { dispose: () => undefined };
  let disconnect: TerminalDisconnectSupport = { dispose: () => undefined };
  try {
    interrupt = installJobControlInterruptSupport(renderer, requestInterrupt);
    suspend = installJobControlSuspendSupport(renderer);
    disconnect = installTerminalDisconnectSupport(stdin, requestQuit);
    root.render(
      <LogApp
        controller={controller}
        runtime={runtime}
        useColor={interactiveLogUsesColor(runtime.input.color, process.env)}
        onOutcome={handleOutcome}
      />,
    );
    return await outcome;
  } finally {
    if (!preparedLaunch) launchAbort.abort();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    interrupt.dispose();
    suspend.dispose();
    disconnect.dispose();
    shutdownSession({ root, renderer, exit: () => undefined });
  }
}

/** Browse history in shared desktop chrome, yielding fully to each child review. */
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
  try {
    await controller.loadMore();
    for (;;) {
      const outcome = await mountLogSurface(controller, runtime, stdin, stdout);
      if (outcome.kind === "quit") {
        if (outcome.exitCode !== undefined) process.exitCode = outcome.exitCode;
        return;
      }
      try {
        const code = await outcome.launch.run();
        controller.setNotice(code === 0 ? "" : "Could not open the selected commit.");
      } catch (error) {
        controller.setNotice(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    await controller.close();
  }
}
