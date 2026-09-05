import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { resolveCurrentHunkCommand } from "../../core/process/relaunch";
import {
  parseTerminalHandoffMessage,
  terminalHandoffEnv,
  terminalHandoffMessage,
} from "../../core/process/terminalHandoff";
import type { ExtensionVcsHistoryReviewAction } from "../../extension-api/types";
import type { HistoryRuntime } from "../history/types";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_BOOTSTRAP_ERROR_BYTES = 16_384;

export interface PreparedHistoryReview {
  /** Release exclusive terminal ownership and wait for the child review to exit. */
  run(): Promise<number>;
  /** Stop a child that never received terminal ownership. */
  abort(): Promise<void>;
}

/** Convert a provider-owned review declaration into one option-safe child invocation. */
export function historyReviewArgs(action: ExtensionVcsHistoryReviewAction) {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64url");
  return [action.kind === "revision-range" ? "diff" : "show", "--history-review", payload];
}

/** Collect bounded bootstrap diagnostics without allowing startup output to disturb the log UI. */
function collectBootstrapError(child: ChildProcess) {
  let output = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (output.length >= MAX_BOOTSTRAP_ERROR_BYTES) return;
    output += chunk.slice(0, MAX_BOOTSTRAP_ERROR_BYTES - output.length);
  });
  return () => output.trim();
}

/** Spawn and bootstrap one provider-planned review while the log still owns the terminal. */
export async function prepareHistoryReview(
  runtime: HistoryRuntime,
  action: ExtensionVcsHistoryReviewAction,
  {
    themeId,
    themeMode,
    signal,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    terminateGraceMs = 1_000,
    spawnImpl = spawn,
    current = resolveCurrentHunkCommand(),
    env = process.env,
    stderr = process.stderr,
  }: {
    themeId?: string;
    themeMode?: "dark" | "light";
    signal?: AbortSignal;
    readyTimeoutMs?: number;
    terminateGraceMs?: number;
    spawnImpl?: typeof spawn;
    current?: ReturnType<typeof resolveCurrentHunkCommand>;
    env?: NodeJS.ProcessEnv;
    stderr?: NodeJS.WritableStream;
  } = {},
): Promise<PreparedHistoryReview> {
  const extensionArgs = runtime.input.extensionPaths.flatMap((path) => [
    "--extension",
    resolve(path),
  ]);
  const args = [
    ...current.args,
    ...historyReviewArgs(action),
    "--vcs",
    runtime.providerId,
    ...(themeId ? ["--theme", themeId] : []),
    ...(runtime.input.extensionsEnabled ? extensionArgs : ["--no-extensions"]),
  ];
  const child = spawnImpl(current.command, args, {
    cwd: runtime.repoRoot,
    env: terminalHandoffEnv({ ...env, HUNK_RETURN_TO_HISTORY: "1" }, themeMode),
    stdio: ["inherit", "inherit", "pipe", "ipc"],
  });
  const bootstrapError = collectBootstrapError(child);
  const exitResult = new Promise<{ code: number; error?: Error }>((resolveExit) => {
    let settled = false;
    const finish = (result: { code: number; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolveExit(result);
    };
    child.once("error", (error) => finish({ code: 1, error }));
    child.once("exit", (code, exitSignal) => finish({ code: exitSignal ? 1 : (code ?? 1) }));
  });
  const childRunning = () => child.exitCode === null && child.signalCode === null;
  const terminateChild = async () => {
    if (!childRunning()) return;
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      exitResult.then(() => true),
      new Promise<false>((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout(false), terminateGraceMs);
        timer.unref?.();
      }),
    ]);
    if (!stopped && childRunning()) {
      child.kill("SIGKILL");
      await exitResult;
    }
  };

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
        if (error) rejectReady(error);
        else resolveReady();
      };
      const onMessage = (value: unknown) => {
        const message = parseTerminalHandoffMessage(value);
        if (message?.kind === "ready") finish();
        if (message?.kind === "failed") finish(new Error(message.message));
      };
      const onError = (error: Error) => finish(error);
      const onExit = () =>
        finish(new Error(bootstrapError() || "The review exited before it was ready."));
      const onAbort = () => finish(new Error("Review launch was cancelled."));
      const timeout = setTimeout(
        () => finish(new Error("Timed out while preparing the selected commit.")),
        readyTimeoutMs,
      );
      timeout.unref?.();
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } catch (error) {
    await terminateChild();
    throw error;
  }

  let released = false;
  const waitForExit = async () => {
    const result = await exitResult;
    if (result.error) throw result.error;
    return result.code;
  };

  return {
    async run() {
      if (released || !childRunning()) return await waitForExit();
      child.stderr?.pipe(stderr);
      try {
        await new Promise<void>((resolveRelease, rejectRelease) => {
          if (!child.connected) {
            rejectRelease(new Error("The review disconnected before terminal release."));
            return;
          }
          child.send(terminalHandoffMessage("release"), (error) => {
            if (error) rejectRelease(error);
            else resolveRelease();
          });
        });
        released = true;
      } catch (error) {
        if (!childRunning()) return await waitForExit();
        await terminateChild();
        throw error;
      }
      return await waitForExit();
    },
    async abort() {
      if (released || !childRunning()) return;
      await terminateChild();
    },
  };
}
