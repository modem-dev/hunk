import { isDeepStrictEqual } from "node:util";
import type { StartupNotice } from "../core/process/startupNotice";
import type { ExtensionsConfig } from "../core/run/config";
import { sanitizeTerminalText } from "../lib/terminalText";
import { discoverExtensions } from "./discovery";
import { retireExtensionLoadResult } from "./events";
import { loadExtensions, type LoadExtensionsOptions } from "./host";
import { createExtensionNotificationHub, type ExtensionNotificationHub } from "./notifications";
import {
  createEmptyExtensionLoadResult,
  type ExtensionCandidate,
  type ExtensionLoadIssue,
  type ExtensionLoadResult,
} from "./types";

/** Keep one failure notice on a single footer row. */
const MAX_ISSUE_MESSAGE_LENGTH = 120;

export interface LoadStartupExtensionsOptions {
  /** Resolved `[extensions]` configuration for this invocation. */
  extensions: ExtensionsConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Entry paths from repeated `--extension` flags. */
  cliExtensionPaths?: readonly string[];
  /** Project root resolved before user extensions execute. */
  projectRoot?: string;
  /** Product-owned ids user extension modules may not claim. */
  reservedExtensionIds?: ReadonlySet<string>;
  /**
   * Sink extension `ctx.notify` calls land in. Pass the hub from an earlier
   * pass when reloading extensions so the mounted UI keeps receiving them.
   */
  notifications?: ExtensionNotificationHub;
  /** Provisional pass that may be extended when final discovery only appends candidates. */
  previousLoad?: ExtensionLoadResult;
  /** Keep factory bus events queued for a possible staged continuation. */
  deferEventBusBinding?: boolean;
  /** Publish provisional ownership before imports or asynchronous factories can suspend. */
  onProvisionalLoad?: (result: ExtensionLoadResult) => void;
  /** Test seams forwarded to the host loader. */
  hostOverrides?: Pick<
    LoadExtensionsOptions,
    "importExtensionModuleImpl" | "resolveRepoTrustImpl" | "repoRoot"
  >;
}

/** Return whether final discovery can safely append to a provisional registry. */
function canExtendPreviousLoad(
  previous: ExtensionLoadResult,
  candidates: readonly ExtensionCandidate[],
  extensionConfigs: Record<string, Record<string, unknown>>,
  cwd: string,
) {
  const priorCandidates = previous.loadState.candidates;
  if (previous.context.cwd !== cwd || priorCandidates.length > candidates.length) {
    return false;
  }

  for (let index = 0; index < priorCandidates.length; index += 1) {
    if (!isDeepStrictEqual(priorCandidates[index], candidates[index])) {
      return false;
    }
  }

  return priorCandidates.every((candidate) =>
    isDeepStrictEqual(
      previous.loadState.extensionConfigs[candidate.id],
      extensionConfigs[candidate.id],
    ),
  );
}

/**
 * Run discovery and loading for one interactive session.
 *
 * Disabled extensions short-circuit to an empty registry so nothing on disk is
 * read, let alone executed. A final staged pass extends an unchanged provisional
 * prefix instead of executing those factories twice.
 */
export async function loadStartupExtensions(
  options: LoadStartupExtensionsOptions,
): Promise<ExtensionLoadResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  // One hub per pass unless the caller supplies the session's existing one, so
  // `ctx.notify` always has somewhere to go even before the UI subscribes.
  const notifications =
    options.notifications ??
    options.previousLoad?.notifications ??
    createExtensionNotificationHub();
  if (!options.extensions.enabled) {
    await retireExtensionLoadResult(options.previousLoad);
    return createEmptyExtensionLoadResult(cwd, notifications);
  }

  const candidates = discoverExtensions({
    cwd,
    env,
    repoRoot: options.projectRoot ?? options.hostOverrides?.repoRoot,
    flagPaths: options.cliExtensionPaths,
    configPaths: options.extensions.paths,
    repoConfigPaths: options.extensions.repoPaths,
  });

  if (candidates.length === 0) {
    await retireExtensionLoadResult(options.previousLoad);
    return createEmptyExtensionLoadResult(cwd, notifications);
  }

  const previousLoad =
    options.previousLoad &&
    canExtendPreviousLoad(
      options.previousLoad,
      candidates,
      options.extensions.extensionConfigs,
      cwd,
    )
      ? options.previousLoad
      : undefined;
  if (options.previousLoad && !previousLoad) {
    await retireExtensionLoadResult(options.previousLoad);
  }
  const candidatesToLoad = previousLoad
    ? candidates.slice(previousLoad.loadState.candidates.length)
    : candidates;

  return await loadExtensions({
    candidates: candidatesToLoad,
    allCandidates: candidates,
    previousLoad,
    cwd,
    env,
    extensionConfigs: options.extensions.extensionConfigs,
    notifications,
    ...options.hostOverrides,
    repoRoot: options.projectRoot ?? options.hostOverrides?.repoRoot,
    reservedExtensionIds: options.reservedExtensionIds,
    deferEventBusBinding: options.deferEventBusBinding,
    onProvisionalLoad: options.onProvisionalLoad,
  });
}

/**
 * Shorten one failure message so it stays readable in the startup notice row.
 *
 * Load failures quote whatever the module threw, which routinely embeds
 * repo-controlled text such as file paths, so the message is stripped of
 * terminal control sequences before it is drawn into the status bar.
 */
function truncateIssueMessage(message: string) {
  const singleLine = sanitizeTerminalText(message).split("\n")[0]?.trim() ?? "";
  return singleLine.length > MAX_ISSUE_MESSAGE_LENGTH
    ? `${singleLine.slice(0, MAX_ISSUE_MESSAGE_LENGTH - 1)}…`
    : singleLine;
}

/** Turn extension load failures into transient startup notices. */
export function createExtensionLoadNotices(issues: readonly ExtensionLoadIssue[]): StartupNotice[] {
  return issues.map((issue) => ({
    key: `extension:${issue.path}`,
    message: `Extension ${issue.extensionId} failed to load • ${truncateIssueMessage(issue.message)}`,
  }));
}

/**
 * Combine config-sourced notices with extension load failures.
 *
 * Returns the original array identity when there is nothing to add, so
 * unchanged reloads do not restart the notice queue.
 */
export function mergeStartupNotices(
  notices: readonly StartupNotice[] | undefined,
  extensionResult: ExtensionLoadResult,
): readonly StartupNotice[] | undefined {
  const extensionNotices = createExtensionLoadNotices(extensionResult.issues);
  if (extensionNotices.length === 0) {
    return notices;
  }

  return [...(notices ?? []), ...extensionNotices];
}
