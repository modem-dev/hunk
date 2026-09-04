import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveCurrentHunkCommand } from "../../core/process/relaunch";
import type { ExtensionVcsHistoryReviewAction } from "../../extension-api/types";
import type { HistoryRuntime } from "../history/types";

/** Convert a provider-owned review declaration into one option-safe child invocation. */
export function historyReviewArgs(action: ExtensionVcsHistoryReviewAction) {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64url");
  return [action.kind === "revision-range" ? "diff" : "show", "--history-review", payload];
}

/** Run one provider-planned child Hunk review after the log renderer yields the terminal. */
export async function launchHistoryReview(
  runtime: HistoryRuntime,
  action: ExtensionVcsHistoryReviewAction,
  themeId?: string,
) {
  const current = resolveCurrentHunkCommand();
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
  const child = spawn(current.command, args, {
    cwd: runtime.repoRoot,
    env: { ...process.env, HUNK_RETURN_TO_HISTORY: "1" },
    stdio: "inherit",
  });
  return await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  });
}
