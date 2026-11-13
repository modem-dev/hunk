/**
 * Runs one review session with no terminal UI, as `hunk <review command> --web` does.
 *
 * The process stays in the foreground as the review's owner: it registers the session with the
 * loopback daemon exactly as a terminal session does, answers every `hunk session` command and
 * brokered review action through the same bridge, prints the review URL on stdout, and waits for
 * SIGINT or SIGTERM. Agent commands go straight to the `ReviewSessionHost`; reloads — the
 * agent's `hunk session reload` and `--watch` changes — go through `ReviewReloadCoordinator`.
 *
 * Terminal-only concerns get explicit headless answers here: repo-local extensions awaiting a
 * trust decision stay disabled and one notice line says so, extension panes, dialogs, and
 * commands are unavailable (their controls already refuse without a mounted UI), startup and
 * update notices go to stderr so stdout carries only the URL, and no view preferences are saved
 * on exit. It imports nothing from a renderer.
 *
 * Shutdown runs in order: stop accepting reloads, close the watch, shut down the extension
 * session, then stop the broker client so the session leaves `hunk session list`.
 */
import type { AppBootstrap } from "../../core/bootstrap";
import { writeStdout } from "../../core/process/stdout";
import type { StartupNotice } from "../../core/process/startupNotice";
import { resolveStartupUpdateNotice } from "../../core/process/updateNotice";
import { deriveReviewRefreshRequest } from "../../core/run/reviewRefresh";
import { startInputWatch, type WatchedInputRuntime } from "../../core/watch/inputWatch";
import { createExtensionSession, type ExtensionSession } from "../../extensions/session";
import type { ExtensionLoadResult } from "../../extensions/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { resolveSessionBrokerConfig } from "../../session/broker/brokerConfig";
import { reviewProcessUrl } from "../review/capability";
import { ReviewSessionHost } from "../review/reviewSessionHost";
import { createHunkSessionBridge } from "./bridge";
import { ReviewReloadCoordinator, withReloadVcsCatalog } from "./reloadCoordinator";
import { createSessionReloadBounds } from "./reloadBounds";
import { createReviewSessionRuntime, type ReviewSessionRuntime } from "./reviewRuntime";

/** Signals that end a headless review; Windows delivers Ctrl+Break as SIGBREAK. */
export const HEADLESS_REVIEW_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];

/** The process surface the runner listens on; tests pass an emitter. */
export interface HeadlessReviewSignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface HeadlessReviewDeps {
  createReviewRuntime?: (bootstrap: AppBootstrap, cwd: string) => ReviewSessionRuntime;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  signals?: HeadlessReviewSignalSource;
  resolveUpdateNotice?: () => Promise<StartupNotice | null>;
  watchRuntime?: WatchedInputRuntime;
  /** Resolve with the running session once it is published; tests drive it directly. */
  onStarted?: (session: HeadlessReviewSession) => void;
}

/** The live pieces of one running headless review, exposed for tests. */
export interface HeadlessReviewSession {
  getHost(): ReviewSessionHost;
  coordinator: ReviewReloadCoordinator;
  runtime: ReviewSessionRuntime;
  extensionSession: ExtensionSession;
  url: string;
  /** Begin the ordered shutdown, as a signal would. */
  shutdown(): Promise<void>;
}

/** Format one notice as the single stderr line headless commands use. */
function noticeLine(message: string) {
  return `hunk: warning: ${sanitizeTerminalLine(message)}\n`;
}

/**
 * Run one headless review until a shutdown signal, then shut down in order.
 *
 * Resolves with the process exit code.
 */
export async function runHeadlessReview(
  launchBootstrap: AppBootstrap<ExtensionLoadResult>,
  deps: HeadlessReviewDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => writeStdout(text));
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const signals = deps.signals ?? process;
  if (!launchBootstrap.extensions) {
    throw new Error("Headless review startup did not provide extension authority.");
  }

  const bootstrap = withReloadVcsCatalog(launchBootstrap);
  const extensionSession = createExtensionSession(
    launchBootstrap.extensions,
    createSessionReloadBounds(bootstrap, { cwd: bootstrap.reloadContext.cwd }).defaultCwd,
  );
  let runtime: ReviewSessionRuntime;
  try {
    runtime = (deps.createReviewRuntime ?? createReviewSessionRuntime)(
      bootstrap,
      bootstrap.reloadContext.cwd,
    );
  } catch (error) {
    await extensionSession.shutdown();
    throw error;
  }
  const { hostClient, reviewProducer: producer } = runtime;
  const stmlEnabled = bootstrap.input.options.experimental === true;

  for (const notice of bootstrap.startupNotices ?? []) {
    stderr(noticeLine(notice.message));
  }
  const pendingTrustRepoRoot = launchBootstrap.extensions.pendingTrustRepoRoot;
  if (pendingTrustRepoRoot) {
    stderr(
      noticeLine(
        `Repo-local extensions in ${pendingTrustRepoRoot} are not trusted and stay disabled in this headless review. Open a terminal review there to decide whether to trust them.`,
      ),
    );
  }

  /** Create the host one mounted review generation lives in. */
  const createHost = (generation: AppBootstrap) =>
    new ReviewSessionHost({
      files: generation.changeset.files,
      sourceLabel: generation.changeset.sourceLabel,
      showAgentNotes: generation.initialShowAgentNotes ?? false,
      stmlEnabled,
    });

  let host = createHost(bootstrap);
  let unsubscribeHost: () => void = () => {};
  let snapshotQueued = false;

  /** Publish the host's current state to the daemon, as the terminal's session bridge does. */
  const publishSnapshot = () => {
    snapshotQueued = false;
    hostClient.updateSnapshot({
      updatedAt: new Date().toISOString(),
      state: host.getSessionSnapshotState({
        publicationGeneration: producer.getPublication().generation,
      }),
    });
  };

  /** Coalesce the dispatches of one intent into one snapshot. */
  const queueSnapshot = () => {
    if (snapshotQueued) return;
    snapshotQueued = true;
    queueMicrotask(publishSnapshot);
  };

  /** Attach one host's store to the producer and republish whenever it changes. */
  const attachHost = (next: ReviewSessionHost) => {
    unsubscribeHost();
    host = next;
    producer.attachStore(host.store);
    unsubscribeHost = host.store.subscribe(queueSnapshot);
    publishSnapshot();
  };

  let watch: { close(): void } | undefined;
  let unregisterRefresh: () => void = () => {};

  /** Register the refresh descriptor and arm watch mode for the review now mounted. */
  const armRefresh = (generation: AppBootstrap) => {
    unregisterRefresh();
    watch?.close();
    watch = undefined;
    const request = deriveReviewRefreshRequest(generation.input, generation.changeset.sourceLabel);
    if (!request) return;
    unregisterRefresh = coordinator.registerRefreshRequest(request);
    if (!generation.input.options.watch || coordinator.isShuttingDown()) return;
    watch = startInputWatch({
      input: generation.input,
      reloadContext: generation.reloadContext,
      runtime: deps.watchRuntime,
      refresh: async () => {
        await coordinator.reload(request.nextInput, {
          reason: "watch",
          resetApp: false,
          sourcePath: request.sourcePath,
        });
      },
    });
  };

  const coordinator = new ReviewReloadCoordinator({
    bootstrap,
    producer,
    hostClient,
    extensionSession,
    extensionLifecycleEnabled: true,
    extensionOwnership: "owned",
    adopt: (adoption) => {
      // A soft reload keeps notes, selection, and filter; a reset starts a fresh review state,
      // as a terminal remount does.
      if (adoption.resetApp) {
        attachHost(createHost(adoption.bootstrap));
      } else {
        host.replaceFiles(adoption.bootstrap.changeset.files, {
          sourceLabel: adoption.bootstrap.changeset.sourceLabel,
        });
        attachHost(host);
      }
      adoption.runMountedLifecycle?.();
      armRefresh(adoption.bootstrap);
    },
  });

  attachHost(host);
  hostClient.setBridge(
    createHunkSessionBridge({
      addLiveComment: (input, commentId, options) => host.addLiveComment(input, commentId, options),
      addLiveCommentBatch: (inputs, requestId, options) =>
        host.addLiveCommentBatch(inputs, requestId, options),
      clearLiveComments: (filePath, options) => host.clearLiveComments(filePath, options),
      navigateToLocation: (input) => host.navigateToLocation(input),
      addAgentLineHighlight: (input) => host.addAgentLineHighlight(input),
      clearAgentLineHighlights: (filePath) => host.clearAgentLineHighlights(filePath),
      openAgentNotes: () => host.setShowAgentNotes(true),
      reloadSession: (nextInput, options) => coordinator.reload(nextInput, { ...options }),
      removeLiveComment: (commentId) => host.removeLiveComment(commentId),
      reviewProducer: producer,
    }),
  );
  coordinator.runInitialLifecycle();
  armRefresh(bootstrap);

  const url = reviewProcessUrl(
    resolveSessionBrokerConfig(deps.env).httpOrigin,
    hostClient.getRegistration().sessionId,
  );
  stdout(`${url}\n`);

  // An update check never delays the URL and never reaches stdout.
  void (deps.resolveUpdateNotice ?? resolveStartupUpdateNotice)()
    .then((notice) => {
      if (notice && !coordinator.isShuttingDown()) stderr(noticeLine(notice.message));
    })
    .catch(() => undefined);

  let shutdownPromise: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  /** Stop reloads, the watch, extensions, and the broker client, in that order. */
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      for (const signal of HEADLESS_REVIEW_SHUTDOWN_SIGNALS) {
        signals.off(signal, onSignal);
      }
      coordinator.beginShutdown();
      watch?.close();
      watch = undefined;
      unregisterRefresh();
      try {
        await coordinator.settleStartedWrites();
        await extensionSession.shutdown();
      } finally {
        unsubscribeHost();
        hostClient.setBridge(null);
        runtime.stop();
        resolveStopped();
      }
    })();
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown();
  };
  for (const signal of HEADLESS_REVIEW_SHUTDOWN_SIGNALS) {
    signals.once(signal, onSignal);
  }

  deps.onStarted?.({
    getHost: () => host,
    coordinator,
    runtime,
    extensionSession,
    url,
    shutdown,
  });

  await stopped;
  return 0;
}
