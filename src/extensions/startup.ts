import type { StartupNotice } from "../core/startupNotice";
import type { ExtensionsConfig } from "../core/types";
import { sanitizeTerminalText } from "../lib/terminalText";
import { discoverExtensions } from "./discovery";
import { loadExtensions, type LoadExtensionsOptions } from "./host";
import { createExtensionNotificationHub, type ExtensionNotificationHub } from "./notifications";
import {
  createEmptyExtensionLoadResult,
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
  /**
   * Sink extension `ctx.notify` calls land in. Pass the hub from an earlier
   * pass when reloading extensions so the mounted UI keeps receiving them.
   */
  notifications?: ExtensionNotificationHub;
  /** Test seams forwarded to the host loader. */
  hostOverrides?: Pick<
    LoadExtensionsOptions,
    "importExtensionModuleImpl" | "resolveRepoTrustImpl" | "repoRoot"
  >;
}

/**
 * Run discovery and loading for one interactive session.
 *
 * Disabled extensions short-circuit to an empty registry so nothing on disk is
 * read, let alone executed.
 */
export async function loadStartupExtensions(
  options: LoadStartupExtensionsOptions,
): Promise<ExtensionLoadResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  // One hub per pass unless the caller supplies the session's existing one, so
  // `ctx.notify` always has somewhere to go even before the UI subscribes.
  const notifications = options.notifications ?? createExtensionNotificationHub();
  if (!options.extensions.enabled) {
    return createEmptyExtensionLoadResult(cwd, notifications);
  }

  const candidates = discoverExtensions({
    cwd,
    env,
    repoRoot: options.hostOverrides?.repoRoot,
    flagPaths: options.cliExtensionPaths,
    configPaths: options.extensions.paths,
    repoConfigPaths: options.extensions.repoPaths,
  });

  if (candidates.length === 0) {
    return createEmptyExtensionLoadResult(cwd, notifications);
  }

  return await loadExtensions({
    candidates,
    cwd,
    env,
    extensionConfigs: options.extensions.extensionConfigs,
    notifications,
    ...options.hostOverrides,
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
