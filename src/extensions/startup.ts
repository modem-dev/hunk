import type { StartupNotice } from "../core/startupNotice";
import type { ExtensionsConfig } from "../core/types";
import { discoverExtensions } from "./discovery";
import { loadExtensions, type LoadExtensionsOptions } from "./host";
import {
  createEmptyExtensionLoadResult,
  type ExtensionLoadIssue,
  type ExtensionLoadResult,
  type ExtensionNotifySink,
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
  /** Where extension `ctx.notify` calls go once the UI owns a toast surface. */
  notify?: ExtensionNotifySink;
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
  if (!options.extensions.enabled) {
    return createEmptyExtensionLoadResult(cwd, options.notify);
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
    return createEmptyExtensionLoadResult(cwd, options.notify);
  }

  return await loadExtensions({
    candidates,
    cwd,
    env,
    extensionConfigs: options.extensions.extensionConfigs,
    notify: options.notify,
    ...options.hostOverrides,
  });
}

/** Shorten one failure message so it stays readable in the startup notice row. */
function truncateIssueMessage(message: string) {
  const singleLine = message.split("\n")[0]?.trim() ?? "";
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
