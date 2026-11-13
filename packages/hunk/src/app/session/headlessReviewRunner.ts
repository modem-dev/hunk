/**
 * Runs one review session with no terminal UI, as `hunk <review command> --web` does.
 *
 * The process stays in the foreground as the review's owner: it registers the session with the
 * loopback daemon exactly as a terminal session does, answers every `hunk session` command and
 * brokered review action through the same bridge, prints the review URL on stdout, and waits for
 * SIGINT, SIGTERM, or SIGHUP, or for a write that finds its stdout or stderr reader gone. While
 * the daemon is away the process idles and the broker client reconnects. Agent commands go straight to the `ReviewSessionHost`; reloads — the
 * agent's `hunk session reload` and `--watch` changes — go through `ReviewReloadCoordinator`.
 *
 * Entry point: `hunk <review command> --web` implies `--watch` (startup applies it unless
 * `--no-watch`). It waits, bounded, until a daemon accepts the session; when none will (another
 * program holds the port, the daemon cannot start, or it is a different Hunk build) it exits with a
 * user error and prints no URL. Otherwise it prints exactly the URL line on stdout, then opens that URL in the default browser
 * unless `--no-open`. A launch failure is one stderr line without the URL, and the review keeps
 * serving. When stderr is a terminal, one line says where the review is — open in the browser,
 * or to be opened from the URL — and that Ctrl+C stops it; a failed launch carries that hint in
 * its warning instead of a second line.
 * `hunk session open` reaches the same opener through the bridge (`./openReview.ts`).
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
import { HunkUserError } from "../../core/run/errors";
import { DAEMON_STARTUP_TIMEOUT_MS } from "../../session/broker/brokerClient";
import {
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "../../session/broker/brokerConfig";
import { reviewProcessUrl } from "../review/capability";
import { ReviewSessionHost } from "../review/reviewSessionHost";
import { buildReviewPresentationDefaults, buildReviewSharedState } from "../review/sharedState";
import type { ReviewPresentationDefaultsV1 } from "../../session/reviewSharedState";
import { createHunkSessionBridge } from "./bridge";
import { ReviewReloadCoordinator, withReloadVcsCatalog } from "./reloadCoordinator";
import { createSessionReloadBounds } from "./reloadBounds";
import { openSessionReview, type ReviewUrlOpener } from "./openReview";
import { createReviewSessionRuntime, type ReviewSessionRuntime } from "./reviewRuntime";

/**
 * Signals that end a headless review, as they end a terminal review. Windows delivers Ctrl+Break
 * as SIGBREAK. Elsewhere a closed terminal sends SIGHUP, and SIGPIPE arrives when a write — this
 * runner's notices or the broker client's console warnings — finds that whoever started the
 * review closed its output or died; Bun otherwise ignores SIGPIPE and the orphan lives on.
 */
export const HEADLESS_REVIEW_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"];

/** How a person at a terminal stops a headless review. */
const HEADLESS_STOP_HINT = "Press Ctrl+C to stop.";

/** Period of the idle timer that keeps the process alive; it never does any work. */
const KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Keep the process alive until shutdown releases it.
 *
 * A headless review waits on a promise, and the broker client's reconnect timers are unref'd, so
 * once the daemon's websocket closes nothing referenced remains in the event loop. Bun then polls
 * with a zero timeout for as long as the top-level await is pending — one core at 100% for the
 * whole time the daemon is away. One referenced idle timer lets the loop block instead.
 */
function holdProcessOpen() {
  const handle = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
  return () => clearInterval(handle);
}

/**
 * How long a headless review waits for a daemon to accept it before giving up: one daemon startup
 * attempt, as a terminal session's auto-start allows, plus the same again for the signed hello.
 */
export const HEADLESS_REGISTRATION_TIMEOUT_MS = 2 * DAEMON_STARTUP_TIMEOUT_MS;

/**
 * Wait until a daemon accepts this session, or fail with a user error naming the daemon port.
 *
 * The broker client reports the first reason registration cannot happen — the port belongs to
 * another process, the daemon did not start, or it is a different Hunk build — and this bound
 * covers a daemon that never answers. The timer is referenced, so the wait blocks the event loop
 * rather than polling it.
 */
async function waitForDaemonRegistration(
  hostClient: Pick<ReviewSessionRuntime["hostClient"], "waitForFirstRegistration">,
  config: Pick<ResolvedSessionBrokerConfig, "host" | "port">,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`No session daemon accepted it within ${Math.ceil(timeoutMs / 1000)} seconds.`),
        ),
      timeoutMs,
    );
  });
  try {
    await Promise.race([hostClient.waitForFirstRegistration(), timedOut]);
  } catch (error) {
    // The broker client's startup timeout promises a background retry; this command exits.
    const reason = (error instanceof Error ? error.message : String(error)).replace(
      / The app will retry in the background\.$/,
      "",
    );
    // Build-skew and port-conflict reasons carry their own remedy; the others get the port one.
    const remedy = /HUNK_MCP_PORT|hunk daemon|relaunch|smaller review/.test(reason)
      ? ""
      : " Stop whatever else holds that port, or set HUNK_MCP_PORT to a different loopback port.";
    throw new HunkUserError(
      `could not serve this review through the session daemon on ${config.host}:${config.port}. ${sanitizeTerminalLine(reason)}${remedy}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Call `onClosed` once stdout or stderr reports that its reader is gone. */
function watchProcessOutputClosed(onClosed: () => void) {
  const onError = (error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === "EPIPE") onClosed();
  };
  process.stdout.on("error", onError);
  process.stderr.on("error", onError);
  return () => {
    process.stdout.off("error", onError);
    process.stderr.off("error", onError);
  };
}

/** The process surface the runner listens on; tests pass an emitter. */
export interface HeadlessReviewSignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface HeadlessReviewDeps {
  createReviewRuntime?: (
    bootstrap: AppBootstrap,
    cwd: string,
    options: { surface: "headless" },
  ) => ReviewSessionRuntime;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  signals?: HeadlessReviewSignalSource;
  resolveUpdateNotice?: () => Promise<StartupNotice | null>;
  watchRuntime?: WatchedInputRuntime;
  /** Resolve with the running session once it is published; tests drive it directly. */
  onStarted?: (session: HeadlessReviewSession) => void;
  /** Open the review URL in a browser; tests inject a recorder so no browser starts. */
  openUrl?: ReviewUrlOpener;
  /** Whether stderr is a terminal, which decides the human hint line. */
  stderrIsTTY?: boolean;
  /** Keep the process alive until the returned release runs; tests count holds instead. */
  holdProcess?: () => () => void;
  /**
   * Call `onClosed` when the process's output has no reader left (EPIPE); returns an unsubscribe.
   * Tests drive it directly.
   */
  watchOutputClosed?: (onClosed: () => void) => () => void;
  /** Bound on waiting for a daemon to accept the session; tests shorten it. */
  registrationTimeoutMs?: number;
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
      { surface: "headless" },
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
  let mountedBootstrap: AppBootstrap = bootstrap;
  let presentation: ReviewPresentationDefaultsV1 | undefined;
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

  /**
   * Attach one host's store and shared state to the producer and republish whenever either
   * changes. Presentation defaults are resolved once per mounted bootstrap, on first read.
   */
  const attachHost = (next: ReviewSessionHost, generation: AppBootstrap) => {
    unsubscribeHost();
    host = next;
    if (generation !== mountedBootstrap) {
      mountedBootstrap = generation;
      presentation = undefined;
    }
    const attached = next;
    producer.attachStore(attached.store, {
      getSharedStateRevision: () => attached.getSharedStateRevision(),
      recordAgentReveal: (target) => attached.recordAgentReveal(target),
      build: (publicationGeneration) =>
        buildReviewSharedState(attached, {
          generation: publicationGeneration,
          presentation: (presentation ??= buildReviewPresentationDefaults(mountedBootstrap)),
        }),
    });
    const unsubscribeStore = attached.store.subscribe(queueSnapshot);
    const unsubscribeShared = attached.subscribeSharedState(queueSnapshot);
    unsubscribeHost = () => {
      unsubscribeStore();
      unsubscribeShared();
    };
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
    // A browser's failed refresh is told `refresh-failed`; the detail is this process's to show.
    onRefreshFailed: (detail) => stderr(noticeLine(detail)),
    adopt: (adoption) => {
      // A soft reload keeps notes, selection, and filter; a reset starts a fresh review state,
      // as a terminal remount does.
      if (adoption.resetApp) {
        attachHost(createHost(adoption.bootstrap), adoption.bootstrap);
      } else {
        host.replaceFiles(adoption.bootstrap.changeset.files, {
          sourceLabel: adoption.bootstrap.changeset.sourceLabel,
        });
        attachHost(host, adoption.bootstrap);
      }
      adoption.runMountedLifecycle?.();
      armRefresh(adoption.bootstrap);
    },
  });

  attachHost(host, bootstrap);
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
      refreshReview: () => coordinator.refreshCurrent(),
      openReview: ({ open }) =>
        openSessionReview(hostClient.getRegistration().sessionId, {
          open,
          env: deps.env,
          openUrl: deps.openUrl,
        }),
      removeLiveComment: (commentId) => host.removeLiveComment(commentId),
      reviewProducer: producer,
    }),
  );
  // The URL is only printed once a daemon has accepted the session and will serve its page.
  const brokerConfig = resolveSessionBrokerConfig(deps.env);
  try {
    await waitForDaemonRegistration(
      hostClient,
      brokerConfig,
      deps.registrationTimeoutMs ?? HEADLESS_REGISTRATION_TIMEOUT_MS,
    );
  } catch (error) {
    unsubscribeHost();
    hostClient.setBridge(null);
    runtime.stop();
    await extensionSession.shutdown();
    throw error;
  }

  coordinator.runInitialLifecycle();
  armRefresh(bootstrap);

  const sessionId = hostClient.getRegistration().sessionId;
  const url = reviewProcessUrl(brokerConfig.httpOrigin, sessionId);
  stdout(`${url}\n`);
  // A person at a terminal gets one line saying where the review is and how to stop it; piped
  // and agent use stays quiet apart from warnings. A failed launch folds the hint into its warning.
  const stderrIsTTY = deps.stderrIsTTY ?? process.stderr.isTTY === true;
  const stopHint = stderrIsTTY ? ` ${HEADLESS_STOP_HINT}` : "";
  if (bootstrap.input.options.open === false) {
    if (stderrIsTTY) stderr(`hunk: open the URL above in a browser.${stopHint}\n`);
  } else {
    // Never awaited: a slow or failing browser launch must not delay or end the review.
    void openSessionReview(sessionId, { open: true, env: deps.env, openUrl: deps.openUrl }).then(
      (result) => {
        if (coordinator.isShuttingDown()) return;
        if (result.failure) {
          stderr(
            noticeLine(`${result.failure} Open the URL above in a browser instead.${stopHint}`),
          );
        } else if (stderrIsTTY) {
          stderr(`hunk: review ready in your browser.${stopHint}\n`);
        }
      },
    );
  }

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
  // The review is a foreground server: it stays alive, idle, while its daemon is away and the
  // broker client reconnects, until a signal or a closed output ends it.
  const releaseProcess = (deps.holdProcess ?? holdProcessOpen)();
  let unwatchOutput: () => void = () => {};

  /** Stop reloads, the watch, extensions, and the broker client, in that order. */
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      for (const signal of HEADLESS_REVIEW_SHUTDOWN_SIGNALS) {
        signals.off(signal, onSignal);
      }
      unwatchOutput();
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
        releaseProcess();
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
  // A parent that died or closed its end of the output pipe can no longer stop this review with
  // Ctrl+C; the next write that finds no reader ends it as a closed terminal would.
  unwatchOutput = (deps.watchOutputClosed ?? watchProcessOutputClosed)(onSignal);

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
