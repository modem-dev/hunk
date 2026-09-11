import type { CliInput, CommonOptions, StatusCommandInput } from "../core/run/commandInputs";
import {
  persistedViewPreferencesFromOptions,
  type PersistedViewPreferences,
  type UserKeyBinding,
} from "../core/run/config";
import { collectSessionCustomThemes } from "../core/theme/customThemes";
import {
  createInteractiveSessionInitialization,
  type InteractiveSessionInitialization,
} from "../core/session/initialization";
import { detectVcs, extendVcsCatalog, getDefaultVcsAdapter, getVcsAdapter } from "../core/vcs";
import type { VcsCatalog } from "../core/vcs/types";
import type {
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsStatusCapability,
  ExtensionVcsStatusSnapshot,
} from "../extension-api/types";
import { resolveExtensionVcsAdapters } from "../extensions/apply";
import { createExtensionSession, type ExtensionSession } from "../extensions/session";
import { mergeStartupNotices } from "../extensions/startup";
import type { ExtensionLoadResult } from "../extensions/types";
import type { AppBootstrap } from "../core/bootstrap";
import type { HistoryBootstrap } from "./historyBootstrap";
import { loadConfiguredSessionBootstrap } from "./sessionBootstrap";
import { openVcsHistory, planVcsHistoryReview, planVcsHistoryRangeReview } from "../core/vcs";
import { resolveConfiguredExtensions } from "./extensionBootstrap";

/** Retain launch config/trust authority while status targets and mounted review routes change. */
export interface StatusBootstrap {
  input: StatusCommandInput;
  snapshot: ExtensionVcsStatusSnapshot;
  providerId: string;
  providerName: string;
  startupCwd: string;
  repoRoot: string;
  launchOptions: CommonOptions;
  extensionSession: ExtensionSession;
  initialization: InteractiveSessionInitialization;
  keybindings: Readonly<Record<string, UserKeyBinding>>;
  initialViewPreferences: PersistedViewPreferences;
  viewPreferencesConfigPath?: string;
  promptSaveViewPreferences: boolean;
  notices: readonly string[];
  load(targetPath?: string, signal?: AbortSignal): Promise<ExtensionVcsStatusSnapshot>;
  loadSiblings(
    snapshot: ExtensionVcsStatusSnapshot,
    signal?: AbortSignal,
  ): Promise<ExtensionVcsStatusSnapshot>;
  planReview(
    snapshot: ExtensionVcsStatusSnapshot,
    actionId: string,
    signal?: AbortSignal,
  ): ReturnType<ExtensionVcsStatusCapability["planReview"]>;
  watchPlan(
    snapshot: ExtensionVcsStatusSnapshot,
    signal?: AbortSignal,
  ): ReturnType<NonNullable<ExtensionVcsStatusCapability["watchPlan"]>>;
  openHistory(targetPath: string, signal?: AbortSignal): Promise<HistoryBootstrap>;
  prepareReview(
    input: CliInput,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<AppBootstrap<ExtensionLoadResult>>;
  prepareHistoryReview(
    action: ExtensionVcsHistoryReviewAction,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<AppBootstrap<ExtensionLoadResult>>;
  /** Cancel and drain provider work; the session host separately retires extension authority. */
  close(): Promise<void>;
}

/** Resolve ordinary launch config/extensions and read current status before scanning siblings. */
export async function loadStatusBootstrap({
  input,
  cwd = process.cwd(),
  env = process.env,
  baseVcsCatalog,
  previousLoad,
  signal,
}: {
  input: StatusCommandInput;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  baseVcsCatalog: VcsCatalog;
  previousLoad?: ExtensionLoadResult;
  signal?: AbortSignal;
}): Promise<StatusBootstrap> {
  signal?.throwIfAborted();
  const resolved = await resolveConfiguredExtensions({
    runtimeInput: { kind: "vcs", staged: false, options: input.options },
    cwd,
    env,
    baseVcsCatalog,
    previousLoad,
    assertActive: () => signal?.throwIfAborted(),
  });
  const extensionSession = createExtensionSession(resolved.extensions, cwd);
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  /** Join route cancellation to session shutdown; reject late results instead of publishing them. */
  const run = <T>(
    requestSignal: AbortSignal | undefined,
    task: (signal: AbortSignal) => Promise<T>,
    disposeLate?: (result: T) => void | Promise<void>,
  ) => {
    const combined = requestSignal
      ? AbortSignal.any([requestSignal, lifetime.signal])
      : lifetime.signal;
    const promise = (async () => {
      combined.throwIfAborted();
      const result = await task(combined);
      if (combined.aborted) await disposeLate?.(result);
      combined.throwIfAborted();
      return result;
    })();
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  try {
    const extensionAdapters = resolveExtensionVcsAdapters(
      resolved.extensions.registry,
      baseVcsCatalog,
    );
    const catalog = extendVcsCatalog(baseVcsCatalog, extensionAdapters.adapters);
    const explicit = input.options.vcs ?? resolved.configured.explicitVcsId;
    const providerId =
      explicit && explicit !== "auto"
        ? explicit
        : (detectVcs(cwd, catalog)?.id ?? getDefaultVcsAdapter(catalog).id);
    const adapter = getVcsAdapter(providerId, catalog);
    const capability = adapter.status;
    if (!capability) throw new Error(`${adapter.name} does not support workspace status.`);
    const context = (signal: AbortSignal) => ({ cwd, signal });
    const load = (targetPath?: string, signal?: AbortSignal) =>
      run(signal, (active) => capability.read({ targetPath }, context(active)));
    const snapshot = await load(undefined, signal);
    const sessionThemes = collectSessionCustomThemes(
      resolved.configured.customThemes,
      resolved.extensions.registry.themes,
    );
    const launchOptions = { ...resolved.configured.input.options, vcs: providerId };
    const initialViewPreferences = persistedViewPreferencesFromOptions(launchOptions);
    extensionSession.startCurrent(cwd);
    // Keep trusted launch configuration fixed; inspected targets supply only source/cwd facts.
    const prepareReview = (input: CliInput, targetCwd: string, signal?: AbortSignal) =>
      run(signal, async (active) => {
        const result = await loadConfiguredSessionBootstrap({
          configured: {
            ...resolved.configured,
            input: { ...input, options: { ...launchOptions, ...input.options, vcs: providerId } },
          },
          cwd: targetCwd,
          extensions: extensionSession.current,
          loadAtCwd: true,
          baseVcsCatalog,
          signal: active,
        });
        return result.bootstrap as AppBootstrap<ExtensionLoadResult>;
      });
    const bootstrap: StatusBootstrap = {
      input: { ...input, options: launchOptions },
      snapshot,
      providerId: adapter.id,
      providerName: adapter.name,
      startupCwd: cwd,
      repoRoot: snapshot.worktree.path,
      launchOptions,
      extensionSession,
      initialization: createInteractiveSessionInitialization({
        theme: { initialTheme: launchOptions.theme, customThemes: sessionThemes.themes },
        viewPreferences: initialViewPreferences,
      }),
      keybindings: resolved.configured.keybindings,
      initialViewPreferences,
      viewPreferencesConfigPath: resolved.configured.viewPreferencesConfigPath,
      promptSaveViewPreferences: launchOptions.promptSaveViewPreferences !== false,
      notices: [
        ...(mergeStartupNotices(resolved.configured.startupNotices, resolved.extensions) ?? []).map(
          (notice) => notice.message,
        ),
        ...sessionThemes.notices.map((notice) => notice.message),
        ...extensionAdapters.issues.map((issue) => issue.message),
      ],
      load,
      loadSiblings: (current, signal) =>
        run(signal, async (active) => {
          try {
            const siblings = await capability.readSiblings(current, context(active));
            return { ...current, siblings: { state: "ready" as const, value: siblings } };
          } catch (error) {
            active.throwIfAborted();
            return {
              ...current,
              siblings: {
                state: "error" as const,
                message: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }),
      planReview: (current, actionId, signal) =>
        run(signal, (active) => capability.planReview(current, actionId, context(active))),
      watchPlan: (current, signal) =>
        run(
          signal,
          (active) =>
            capability.watchPlan?.(current, context(active)) ??
            Promise.resolve({ coverage: "poll-only", targets: [] }),
        ),
      prepareReview,
      prepareHistoryReview(action, targetCwd, signal) {
        return prepareReview(
          action.kind === "revision-show"
            ? { kind: "show", ref: action.revisionId, options: {} }
            : {
                kind: "vcs",
                staged: false,
                rangeEndpoints: { from: action.fromRevisionId, to: action.toRevisionId },
                options: {},
              },
          targetCwd,
          signal,
        );
      },
      openHistory(targetPath, signal) {
        return run(
          signal,
          async (active) => {
            const current = await capability.read({ targetPath }, context(active));
            if (current.worktree.repositoryId !== snapshot.worktree.repositoryId)
              throw new Error("Status repository identity changed.");
            const targetCwd = current.worktree.path;
            const open = (signal?: AbortSignal) =>
              openVcsHistory(adapter, {}, { cwd: targetCwd, signal }, catalog);
            let source = await open(active);
            if (active.aborted) {
              await source.close();
              active.throwIfAborted();
            }
            let closed = false;
            return {
              input: {
                kind: "history",
                color: input.color,
                format: "medium",
                ascii: false,
                static: false,
                extensionsEnabled: launchOptions.extensions !== false,
                extensionPaths: launchOptions.extensionPaths ?? [],
              },
              source,
              providerId,
              providerName: adapter.name,
              startupCwd: cwd,
              repoRoot: targetCwd,
              extensionSession,
              notices: [],
              customThemes: sessionThemes.themes,
              initialization: bootstrap.initialization,
              keybindings: bootstrap.keybindings,
              initialViewPreferences,
              promptSaveViewPreferences: false,
              planReview: (commit, options, signal) =>
                planVcsHistoryReview(adapter, commit, { cwd: targetCwd, signal }, options),
              ...(adapter.history?.planRangeReview
                ? {
                    planRangeReview: (selection, options, signal) =>
                      planVcsHistoryRangeReview(
                        adapter,
                        selection,
                        { cwd: targetCwd, signal },
                        options,
                      ),
                  }
                : {}),
              async reopenSource(signal) {
                if (closed) throw new Error("History session is closed.");
                const previous = source;
                const replacement = await open(signal);
                if (closed || source !== previous || signal?.aborted) {
                  await replacement.close();
                  throw new Error("History session changed while refreshing.");
                }
                source = replacement;
                await previous.close();
                return replacement;
              },
              async close() {
                if (!closed) {
                  closed = true;
                  await source.close();
                }
              },
            } satisfies HistoryBootstrap;
          },
          (history) => history.close(),
        );
      },
      async close() {
        lifetime.abort(new Error("Status session closed."));
        await Promise.allSettled(pending);
      },
    };
    return bootstrap;
  } catch (error) {
    lifetime.abort();
    await Promise.allSettled(pending);
    await extensionSession.shutdown();
    throw error;
  }
}
