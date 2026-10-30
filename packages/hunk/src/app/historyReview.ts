import { resolve } from "node:path";
import type { AppBootstrap } from "../core/bootstrap";
import type { InteractiveSessionInitialization } from "../core/session/initialization";
import type { TerminalThemeMode } from "../core/theme/detection";
import type { ExtensionVcsHistoryReviewAction } from "../extension-api/types";
import { retireExtensionLoadResult } from "../extensions/events";
import type { ExtensionLoadResult } from "../extensions/types";
import { prepareStartupPlan } from "./startup";

export interface EmbeddedHistoryReviewRequest {
  action: ExtensionVcsHistoryReviewAction;
  providerId: string;
  startupCwd: string;
  extensionsEnabled: boolean;
  extensionPaths: readonly string[];
  extensionSession?: ExtensionLoadResult;
  themeId?: string;
  themeMode?: TerminalThemeMode;
}

export interface EmbeddedHistoryReview {
  bootstrap: AppBootstrap<ExtensionLoadResult>;
  initialization: InteractiveSessionInitialization;
  /** The history session owns this bootstrap's extension registry. */
  borrowsExtensions: boolean;
}

/** Convert a provider-owned review declaration into one option-safe internal invocation. */
export function historyReviewArgs(action: ExtensionVcsHistoryReviewAction) {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64url");
  return [action.kind === "revision-range" ? "diff" : "show", "--history-review", payload];
}

/** Bootstrap one provider-planned history review without creating or claiming a renderer. */
export async function prepareEmbeddedHistoryReview(
  request: EmbeddedHistoryReviewRequest,
  {
    signal,
    env = process.env,
    prepareStartupPlanImpl = prepareStartupPlan,
  }: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    prepareStartupPlanImpl?: typeof prepareStartupPlan;
  } = {},
): Promise<EmbeddedHistoryReview> {
  signal?.throwIfAborted();
  const extensionArgs = request.extensionPaths.flatMap((path) => [
    "--extension",
    resolve(request.startupCwd, path),
  ]);
  const args = [
    ...historyReviewArgs(request.action),
    "--vcs",
    request.providerId,
    ...(request.themeId ? ["--theme", request.themeId] : []),
    ...(request.extensionsEnabled ? extensionArgs : ["--no-extensions"]),
  ];
  const plan = await prepareStartupPlanImpl(["hunk", "hunk", ...args], {
    cwd: request.startupCwd,
    env,
    signal,
    borrowedExtensionLoad: request.extensionSession,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    terminalThemeMode: request.themeMode,
  });
  if (signal?.aborted && plan.kind === "app") {
    plan.controllingTerminal?.close();
    if (plan.bootstrap.extensions?.registry !== request.extensionSession?.registry) {
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
    initialization: plan.initialization,
    borrowsExtensions: plan.bootstrap.extensions?.registry === request.extensionSession?.registry,
  };
}
