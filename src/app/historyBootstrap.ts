import type { HistoryCommandInput } from "../core/run/commandInputs";
import { collectSessionCustomThemes } from "../core/theme/customThemes";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsHistoryReviewOptions,
  NamedCustomThemeConfig,
} from "../extension-api/types";
import { sanitizeTerminalLine } from "../lib/terminalText";
import {
  detectVcs,
  extendVcsCatalog,
  getDefaultVcsAdapter,
  getVcsAdapter,
  openVcsHistory,
  planVcsHistoryReview,
} from "../core/vcs";
import type { VcsCatalog, VcsHistorySource } from "../core/vcs/types";
import { resolveExtensionVcsAdapters, resolveSessionVcsId } from "../extensions/apply";
import { emitExtensionEvent, retireExtensionLoadResult } from "../extensions/events";
import { mergeStartupNotices } from "../extensions/startup";
import type { ExtensionLoadResult } from "../extensions/types";
import { resolveConfiguredExtensions } from "./extensionBootstrap";

/** Fully owned resources required by static or interactive history output. */
export interface HistoryBootstrap {
  input: HistoryCommandInput;
  source: VcsHistorySource;
  providerId: string;
  providerName: string;
  startupCwd: string;
  repoRoot: string;
  extensions: ExtensionLoadResult;
  /** History-owned extension authority borrowed by embedded reviews. */
  extensionSession: ExtensionLoadResult;
  notices: readonly string[];
  customThemes: readonly NamedCustomThemeConfig[];
  planReview(
    commit: ExtensionVcsHistoryCommit,
    options?: ExtensionVcsHistoryReviewOptions,
  ): Promise<ExtensionVcsHistoryReviewAction>;
  reopenSource(signal?: AbortSignal): Promise<VcsHistorySource>;
  close(): Promise<void>;
}

/** Resolve configured/user VCS adapters and open the selected history capability. */
export async function loadHistoryBootstrap({
  input,
  cwd = process.cwd(),
  env = process.env,
  baseVcsCatalog,
  previousLoad,
}: {
  input: HistoryCommandInput;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  baseVcsCatalog: VcsCatalog;
  previousLoad?: ExtensionLoadResult;
}): Promise<HistoryBootstrap> {
  // Reuse the established extension/config discovery with a non-executed review-shaped input.
  // History-specific flags remain separate and never inherit review view preferences.
  const runtimeInput = {
    kind: "show" as const,
    options: {
      ...(input.vcs ? { vcs: input.vcs } : {}),
      ...(input.theme ? { theme: input.theme } : {}),
      extensions: input.extensionsEnabled,
      ...(input.extensionPaths.length ? { extensionPaths: [...input.extensionPaths] } : {}),
    },
  };
  const resolved = await resolveConfiguredExtensions({
    runtimeInput,
    cwd,
    env,
    baseVcsCatalog,
    previousLoad,
  });
  const extensionAdapters = resolveExtensionVcsAdapters(
    resolved.extensions.registry,
    baseVcsCatalog,
  );
  const sessionThemes = collectSessionCustomThemes(
    resolved.configured.customThemes,
    resolved.extensions.registry.themes,
  );
  const catalog = extendVcsCatalog(baseVcsCatalog, extensionAdapters.adapters);
  const explicitVcsId = input.vcs ?? resolved.configured.explicitVcsId;
  const detection = detectVcs(cwd, catalog);
  const settledVcs = resolveSessionVcsId(explicitVcsId, cwd, catalog);
  const providerId = settledVcs.vcsId ?? detection?.id ?? getDefaultVcsAdapter(catalog).id;
  let adapter;
  try {
    adapter = getVcsAdapter(providerId, catalog);
  } catch (error) {
    await retireExtensionLoadResult(resolved.extensions);
    throw error;
  }
  let selectedDetection;
  try {
    selectedDetection = adapter.detect(cwd);
  } catch {
    selectedDetection = null;
  }
  const repoRoot = selectedDetection?.repoRoot ?? cwd;

  const historyInput = {
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.all ? { all: true } : {}),
    ...(input.firstParent ? { firstParent: true } : {}),
    ...(input.maxCount !== undefined ? { maxCount: input.maxCount } : {}),
    ...(input.author !== undefined ? { author: input.author } : {}),
    ...(input.grep !== undefined ? { grep: input.grep } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
    ...(input.pathspecs ? { pathspecs: [...input.pathspecs] } : {}),
  };
  const openSource = (signal?: AbortSignal) =>
    openVcsHistory(adapter, historyInput, { cwd: repoRoot, signal }, catalog);
  let source: VcsHistorySource;
  try {
    source = await openSource();
    emitExtensionEvent(resolved.extensions, "startup", { cwd });
  } catch (error) {
    await retireExtensionLoadResult(resolved.extensions);
    throw error;
  }

  const resolvedTheme = resolved.configured.input.options.theme;
  let closed = false;
  return {
    input: resolvedTheme ? { ...input, theme: resolvedTheme } : input,
    source,
    providerId: sanitizeTerminalLine(adapter.id),
    providerName: sanitizeTerminalLine(adapter.name),
    startupCwd: cwd,
    repoRoot,
    extensions: resolved.extensions,
    extensionSession: resolved.extensions,
    customThemes: sessionThemes.themes,
    notices: [
      ...(mergeStartupNotices(resolved.configured.startupNotices, resolved.extensions) ?? []).map(
        (notice) => sanitizeTerminalLine(notice.message),
      ),
      ...sessionThemes.notices.map((notice) => sanitizeTerminalLine(notice.message)),
      ...extensionAdapters.issues.map((issue) => sanitizeTerminalLine(issue.message)),
      ...(settledVcs.unknownVcsId
        ? [
            `Configured VCS "${sanitizeTerminalLine(settledVcs.unknownVcsId)}" is unavailable; using ${sanitizeTerminalLine(adapter.name)}.`,
          ]
        : []),
    ],
    planReview(commit, options) {
      return planVcsHistoryReview(adapter, commit, { cwd: repoRoot }, options);
    },
    async reopenSource(signal) {
      if (closed) throw new Error("History session is closed.");
      signal?.throwIfAborted();
      const previous = source;
      const replacement = await openSource(signal);
      if (closed || source !== previous || signal?.aborted) {
        await replacement.close();
        signal?.throwIfAborted();
        throw new Error("History session changed while refreshing.");
      }
      source = replacement;
      await previous.close();
      return replacement;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await source.close();
      } finally {
        await retireExtensionLoadResult(resolved.extensions);
      }
    },
  };
}
